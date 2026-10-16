import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { initializeApp } from "firebase/app";
import { getDatabase, ref as dbRef, onValue, set as dbSet, update as dbUpdate, remove as dbRemove } from "firebase/database";

/* ------------------------------- Firebase ------------------------------- */
const firebaseConfig = {
  apiKey: "AIzaSyAukTZj5dPHZRm9UwK5kNsPwcSa9fbG1gM",
  authDomain: "lembrei-ebd7b.firebaseapp.com",
  databaseURL: "https://lembrei-ebd7b-default-rtdb.firebaseio.com",
  projectId: "lembrei-ebd7b",
  storageBucket: "lembrei-ebd7b.firebasestorage.app",
  messagingSenderId: "1076705720064",
  appId: "1:1076705720064:web:4ddd43cd84229a98a3e5e5",
};
const db = getDatabase(initializeApp(firebaseConfig));
const remindersRef = dbRef(db, "reminders");
const itemRef = (id) => dbRef(db, `reminders/${id}`);
// o Realtime Database não aceita `undefined`
const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
const logErr = (e) => console.error("Firebase:", e);

/* ------------------------------ utilitários ------------------------------ */
const pad = (n) => String(n).padStart(2, "0");
const toKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fromKey = (k) => {
  const [y, m, d] = k.split("-").map(Number);
  return new Date(y, m - 1, d);
};
const addDays = (d, n) => {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
};
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
const norm = (s) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

function dateLabel(key) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const d = fromKey(key);
  const diff = Math.round((d - today) / 86400000);
  if (diff === 0) return "Hoje";
  if (diff === 1) return "Amanhã";
  if (diff === -1) return "Ontem";
  return cap(d.toLocaleDateString("pt-BR", { weekday: "short", day: "numeric", month: "short" }));
}

function greeting(d) {
  const h = d.getHours();
  if (h < 12) return "Bom dia,";
  if (h < 18) return "Boa tarde,";
  return "Boa noite,";
}

/* ------------------- interpretação da fala (pt-BR) ------------------- */
const TRIGGER =
  /^\s*(?:por favor[, ]*)?(?:(?:me\s+)?(?:lembrete|lembr(?:ando|ar|e|a)(?:-me)?|adicione|adicionar|crie|criar|anote|anotar))\s*(?:(?:um\s+)?lembrete\s*)?(?:de\s+|para\s+|que\s+|: ?)?/i;

const END = "(?=\\s|$|[.,;!?])";
const PER = "(?:\\s+(?:da|de|pela|à|a)\\s+(manhã|manha|tarde|noite|madrugada))?";
const MONTH = "(janeiro|fevereiro|mar[cç]o|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)";
const MONTHS = { janeiro: 0, fevereiro: 1, marco: 2, abril: 3, maio: 4, junho: 5, julho: 6, agosto: 7, setembro: 8, outubro: 9, novembro: 10, dezembro: 11 };
const WEEK = { domingo: 0, segunda: 1, terca: 2, quarta: 3, quinta: 4, sexta: 5, sabado: 6 };

const RE = {
  rel: new RegExp("(^|\\s)(?:em|daqui\\s+a)\\s+(\\d{1,3})\\s+(minutos?|horas?|dias?)" + END, "i"),
  noon: new RegExp("(^|\\s)(?:ao\\s+)?meio[- ]dia" + END, "i"),
  midnight: new RegExp("(^|\\s)(?:[àa]\\s+)?meia[- ]noite" + END, "i"),
  timeA: new RegExp("(^|\\s)(?:(?:às|as|à|a)\\s+)?(\\d{1,2})(?:[:h]\\s?(\\d{2})|\\s*h(?:oras?)?)" + PER + END, "i"),
  timeB: new RegExp("(^|\\s)(?:às|as|à)\\s+(\\d{1,2})" + PER + END, "i"),
  timeC: new RegExp("(^|\\s)(\\d{1,2})\\s+(?:da|de|pela)\\s+(manhã|manha|tarde|noite|madrugada)" + END, "i"),
  afterTomorrow: new RegExp("(^|\\s)depois\\s+de\\s+amanh[ãa]" + END, "i"),
  tomorrow: new RegExp("(^|\\s)amanh[ãa]" + END, "i"),
  today: new RegExp("(^|\\s)hoje" + END, "i"),
  weekday: new RegExp("(^|\\s)(?:(?:n[ao]|para|pra)\\s+)?(?:pr[oó]xim[ao]\\s+)?(domingo|segunda|ter[cç]a|quarta|quinta|sexta|s[aá]bado)(?:-feira)?" + END, "i"),
  dayMonth: new RegExp("(^|\\s)(?:(?:no|para|pra)\\s+)?(?:dia\\s+)?(\\d{1,2})\\s+de\\s+" + MONTH + END, "i"),
  dayNum: new RegExp("(^|\\s)(?:(?:no|para|pra)\\s+)?dia\\s+(\\d{1,2})" + END, "i"),
};

function toTime(h, m, per) {
  h = Number(h);
  m = Number(m || 0);
  const p = per ? norm(per) : "";
  if ((p === "tarde" || p === "noite") && h < 12) h += 12;
  if ((p === "noite" || p === "madrugada") && h === 12) h = 0;
  if (h > 23 || m > 59) return "";
  return `${pad(h)}:${pad(m)}`;
}

function parseReminder(raw, defaultKey) {
  let s = raw.trim().replace(TRIGGER, "");
  const take = (re) => {
    const m = s.match(re);
    if (!m) return null;
    s = s.replace(re, " ");
    return m;
  };
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let date = "";
  let time = "";
  let m;

  // "em 30 minutos", "daqui a 2 horas", "em 3 dias"
  if ((m = take(RE.rel))) {
    const n = Number(m[2]);
    const u = m[3].toLowerCase();
    const t = new Date(now);
    if (u.startsWith("min")) t.setMinutes(t.getMinutes() + n);
    else if (u.startsWith("hora")) t.setHours(t.getHours() + n);
    else t.setDate(t.getDate() + n);
    date = toKey(t);
    if (!u.startsWith("dia")) time = `${pad(t.getHours())}:${pad(t.getMinutes())}`;
  }

  // horário
  if (!time) {
    if ((m = take(RE.noon))) time = "12:00";
    else if ((m = take(RE.midnight))) time = "00:00";
    else if ((m = take(RE.timeA))) time = toTime(m[2], m[3], m[4]);
    else if ((m = take(RE.timeB))) time = toTime(m[2], 0, m[3]);
    else if ((m = take(RE.timeC))) time = toTime(m[2], 0, m[3]);
  }

  // data
  if (!date) {
    if ((m = take(RE.afterTomorrow))) date = toKey(addDays(today, 2));
    else if ((m = take(RE.tomorrow))) date = toKey(addDays(today, 1));
    else if ((m = take(RE.today))) date = toKey(today);
    else if ((m = take(RE.weekday))) {
      const target = WEEK[norm(m[2])];
      let diff = (target - today.getDay() + 7) % 7;
      if (diff === 0) diff = 7;
      date = toKey(addDays(today, diff));
    } else if ((m = take(RE.dayMonth))) {
      const month = MONTHS[norm(m[3])];
      let d = new Date(today.getFullYear(), month, Number(m[2]));
      if (d < today) d = new Date(today.getFullYear() + 1, month, Number(m[2]));
      date = toKey(d);
    } else if ((m = take(RE.dayNum))) {
      let d = new Date(today.getFullYear(), today.getMonth(), Number(m[2]));
      if (d < today) d = new Date(today.getFullYear(), today.getMonth() + 1, Number(m[2]));
      date = toKey(d);
    }
  }

  if (!date) {
    date = defaultKey || toKey(today);
    // horário que já passou hoje → assume amanhã
    if (time && !defaultKey) {
      const due = new Date(`${toKey(today)}T${time}:00`);
      if (due < now) date = toKey(addDays(today, 1));
    }
  }

  // limpeza do texto
  s = s.replace(/\s+/g, " ").trim();
  let prev;
  do {
    prev = s;
    s = s.replace(/\s+(?:às|as|à|a|em|no|na|para|pra|de|do|da|dia|ao|o)\s*$/i, "").trim();
  } while (s !== prev);
  s = s.replace(/^[\s,.;:!?-]+|[\s,.;:!?-]+$/g, "").replace(/^(?:de|para|que)\s+/i, "");
  if (!s) s = raw.trim().replace(TRIGGER, "").trim() || raw.trim();

  return { text: cap(s), date, time };
}

/* ------------------------- períodos do dia ------------------------- */
const PERIODS = [
  { id: "madrugada", label: "Madrugada", range: "00h–06h", from: 0, to: 6 },
  { id: "manha", label: "Manhã", range: "06h–12h", from: 6, to: 12 },
  { id: "tarde", label: "Tarde", range: "12h–18h", from: 12, to: 18 },
  { id: "noite", label: "Noite", range: "18h–24h", from: 18, to: 24 },
  { id: "sem", label: "Sem horário", range: "", from: -1, to: -1 },
];
function periodOf(time) {
  if (!time) return "sem";
  const h = Number(time.slice(0, 2));
  return PERIODS.find((p) => h >= p.from && h < p.to)?.id || "sem";
}

/* ------------------- dados (trocar por Firebase depois) ------------------- */
function useReminders() {
  // começa com o último cache local: as tarefas aparecem na hora, antes do Firebase responder
  const [items, setItems] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem("lembrei:cache")) || [];
    } catch {
      return [];
    }
  });
  const [loaded, setLoaded] = useState(false);
  const itemsRef = useRef([]);
  itemsRef.current = items;

  // fica ouvindo o banco: qualquer mudança (inclusive de outro aparelho) chega aqui
  useEffect(() => {
    const off = onValue(
      remindersRef,
      (snap) => {
        const list = Object.values(snap.val() || {});
        setItems(list);
        try {
          localStorage.setItem("lembrei:cache", JSON.stringify(list));
        } catch {
          /* armazenamento indisponível */
        }
        setLoaded(true);
      },
      (e) => {
        logErr(e);
        setLoaded(true);
      }
    );
    return off;
  }, []);

  const add = useCallback(async (r) => {
    const item = clean({ id: uid(), done: false, createdAt: Date.now(), ...r });
    dbSet(itemRef(item.id), item).catch(logErr);
    return item;
  }, []);

  const toggle = useCallback(async (id) => {
    const cur = itemsRef.current.find((i) => i.id === id);
    if (!cur) return;
    // completedAt: null apaga o campo no banco
    dbUpdate(itemRef(id), { done: !cur.done, completedAt: cur.done ? null : Date.now() }).catch(logErr);
  }, []);

  const update = useCallback(async (id, fields) => {
    dbUpdate(itemRef(id), clean(fields)).catch(logErr);
  }, []);

  const remove = useCallback(async (id) => {
    dbRemove(itemRef(id)).catch(logErr);
  }, []);

  const clearDone = useCallback(async () => {
    const batch = {};
    itemsRef.current.filter((i) => i.done).forEach((i) => (batch[i.id] = null));
    if (Object.keys(batch).length) dbUpdate(remindersRef, batch).catch(logErr);
  }, []);

  return { items, loaded, add, toggle, update, remove, clearDone };
}

/* ------------------------------- ícones ------------------------------- */
function Icon({ name, size = 20 }) {
  const p = { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true };
  switch (name) {
    case "plus":
      return (<svg {...p}><path d="M12 5v14M5 12h14" /></svg>);
    case "x":
      return (<svg {...p}><path d="M6 6l12 12M18 6L6 18" /></svg>);
    case "check":
      return (<svg {...p} strokeWidth={2.6}><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>);
    case "mic":
      return (<svg {...p}><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0014 0M12 18v3" /></svg>);
    case "send":
      return (<svg {...p} strokeWidth={2.2}><path d="M12 19V5M6 11l6-6 6 6" /></svg>);
    case "calendar":
      return (<svg {...p}><rect x="4" y="5" width="16" height="15" rx="3" /><path d="M8 3v4M16 3v4M4 10h16" /><circle cx="12" cy="15" r="1.4" fill="currentColor" stroke="none" /></svg>);
    case "edit":
      return (<svg {...p}><path d="M4 20h4L19 9a2.8 2.8 0 00-4-4L4 16v4zM13.5 6.5l4 4" /></svg>);
    case "back":
      return (<svg {...p}><path d="M19 12H5M11 6l-6 6 6 6" /></svg>);
    case "done":
      return (<svg {...p}><circle cx="12" cy="12" r="9" /><path d="M8 12.5l3 3 5-6" /></svg>);
    case "bell":
      return (<svg {...p}><path d="M6 16V11a6 6 0 1112 0v5l1.5 2h-15L6 16zM10 20a2 2 0 004 0" /></svg>);
    case "chev-left":
      return (<svg {...p} strokeWidth={2.2}><path d="M14.5 6l-6 6 6 6" /></svg>);
    case "chev-right":
      return (<svg {...p} strokeWidth={2.2}><path d="M9.5 6l6 6-6 6" /></svg>);
    case "clock":
      return (<svg {...p}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3.5 2" /></svg>);
    case "trash":
      return (<svg {...p}><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 002 2h6a2 2 0 002-2l1-12M9 7V4h6v3" /></svg>);
    case "sun":
      return (<svg {...p}><circle cx="12" cy="12" r="4" /><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4" /></svg>);
    case "moon":
      return (<svg {...p}><path d="M20 14.2A8 8 0 019.8 4 8 8 0 1020 14.2z" /></svg>);
    default:
      return null;
  }
}

/* ------------------------- reconhecimento de voz ------------------------- */
const SR = typeof window !== "undefined" ? window.SpeechRecognition || window.webkitSpeechRecognition : null;

function Said({ text }) {
  const m = text.match(TRIGGER);
  if (!m || !m[0].trim()) return <>{text}</>;
  const lead = m[0].replace(/\s+$/, "");
  return (
    <>
      <span className="hl">{lead}</span>
      {text.slice(lead.length)}
    </>
  );
}

function VoiceOverlay({ name, defaultDate, onSave }) {
  const [listening, setListening] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [error, setError] = useState("");
  const [parsed, setParsed] = useState(null);
  const [typed, setTyped] = useState("");
  const recRef = useRef(null);
  const txtRef = useRef("");

  const interpret = useCallback(
    (t) => {
      const clean = t.trim();
      if (clean) setParsed(parseReminder(clean, defaultDate));
    },
    [defaultDate]
  );

  const start = useCallback(() => {
    if (!SR) return;
    setError("");
    setParsed(null);
    setTranscript("");
    txtRef.current = "";
    const rec = new SR();
    rec.lang = "pt-BR";
    rec.interimResults = true;
    rec.continuous = false;
    rec.maxAlternatives = 1;
    rec.onstart = () => setListening(true);
    rec.onresult = (e) => {
      let t = "";
      for (let i = 0; i < e.results.length; i++) t += e.results[i][0].transcript;
      txtRef.current = t;
      setTranscript(t);
    };
    rec.onerror = (e) => {
      const msgs = {
        "not-allowed": "Permita o acesso ao microfone no navegador para usar a voz.",
        "service-not-allowed": "Permita o acesso ao microfone no navegador para usar a voz.",
        "no-speech": "Não ouvi nada. Toque no microfone e tente de novo.",
        "audio-capture": "Nenhum microfone encontrado.",
        network: "Sem conexão com o serviço de voz.",
      };
      if (e.error !== "aborted") setError(msgs[e.error] || "Não foi possível usar o microfone.");
    };
    rec.onend = () => {
      setListening(false);
      interpret(txtRef.current);
    };
    recRef.current = rec;
    try {
      rec.start();
    } catch {
      /* já estava ouvindo */
    }
  }, [interpret]);

  useEffect(() => {
    start();
    return () => {
      const r = recRef.current;
      if (r) {
        r.onend = null;
        r.onerror = null;
        r.onresult = null;
        try {
          r.abort();
        } catch {
          /* noop */
        }
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onMic = () => {
    if (listening) recRef.current?.stop();
    else start();
  };

  return (
    <div className="overlay" role="dialog" aria-label="Comando de voz">
      <div className="panel">
        <h2 className="panel-title">
          Como posso te ajudar, <strong>{name}</strong>?
        </h2>

        <div className="said" aria-live="polite">
          {parsed ? (
            <div className="preview">
              <p className="pv-text">{parsed.text}</p>
              <div className="pv-meta">
                <span className="chip">{dateLabel(parsed.date)}</span>
                {parsed.time && <span className="chip">{parsed.time}</span>}
              </div>
            </div>
          ) : transcript ? (
            <p className="said-text">
              <Said text={transcript} />
            </p>
          ) : (
            <p className="said-hint">
              {listening ? "Estou ouvindo…" : "Toque no microfone e fale."}
              <br />
              <span>Ex.: “Lembre-me de ligar para a Maria amanhã às 14h”</span>
            </p>
          )}
          {error && <p className="error">{error}</p>}
        </div>

        {!SR && (
          <form
            className="typed"
            onSubmit={(e) => {
              e.preventDefault();
              interpret(typed);
            }}
          >
            <p className="error">Este navegador não tem reconhecimento de voz. Digite a frase:</p>
            <input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Lembre-me de…" />
            <button className="btn ghost" type="submit">Interpretar</button>
          </form>
        )}

        {parsed && (
          <div className="pv-actions">
            <button className="btn ghost" onClick={start} disabled={!SR}>Falar de novo</button>
            <button className="btn primary" onClick={() => onSave(parsed)}>Adicionar</button>
          </div>
        )}

        <div className="mic-wrap">
          <span className={"ring r2" + (listening ? " on" : "")} />
          <span className={"ring r1" + (listening ? " on" : "")} />
          <button
            className="mic-btn"
            onClick={onMic}
            disabled={!SR}
            aria-label={listening ? "Parar de ouvir" : "Começar a ouvir"}
          >
            <Icon name="mic" size={30} />
          </button>
        </div>
      </div>
    </div>
  );
}

/* --------------------------- novo lembrete (manual) --------------------------- */
/* ------------------------- seletores de data e hora ------------------------- */
function usePopover(open, setOpen, ref) {
  useEffect(() => {
    if (!open) return;
    const onDown = (e) => ref.current && !ref.current.contains(e.target) && setOpen(false);
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation(); // fecha só o seletor, não o formulário inteiro
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("touchstart", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("touchstart", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open, setOpen, ref]);
}

const WEEK_INITIALS = ["D", "S", "T", "Q", "Q", "S", "S"];

function DatePicker({ value, onChange }) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState(() => (value ? fromKey(value) : new Date()));
  const ref = useRef(null);
  usePopover(open, setOpen, ref);

  const toggle = () => {
    if (!open) setView(value ? fromKey(value) : new Date());
    setOpen(!open);
  };

  const y = view.getFullYear();
  const m = view.getMonth();
  const first = new Date(y, m, 1);
  const start = addDays(first, -first.getDay());
  const cells = Array.from({ length: 42 }, (_, i) => addDays(start, i));
  const todayK = toKey(new Date());
  const shown = value ? fromKey(value).toLocaleDateString("pt-BR") : "dd/mm/aaaa";

  return (
    <div className="pick" ref={ref}>
      <button type="button" className={"field pick-btn" + (open ? " open" : "")} onClick={toggle} aria-haspopup="dialog" aria-expanded={open}>
        <span className={value ? "" : "ph"}>{shown}</span>
        <Icon name="calendar" size={20} />
      </button>
      {open && (
        <div className="pop pop-date" role="dialog" aria-label="Escolher data">
          <div className="pop-head">
            <b>{cap(view.toLocaleDateString("pt-BR", { month: "long", year: "numeric" }))}</b>
            <div className="pop-nav">
              <button type="button" onClick={() => setView(new Date(y, m - 1, 1))} aria-label="Mês anterior">
                <Icon name="chev-left" size={18} />
              </button>
              <button type="button" onClick={() => setView(new Date(y, m + 1, 1))} aria-label="Próximo mês">
                <Icon name="chev-right" size={18} />
              </button>
            </div>
          </div>
          <div className="cal-grid cal-week">
            {WEEK_INITIALS.map((w, i) => (
              <span key={i}>{w}</span>
            ))}
          </div>
          <div className="cal-grid">
            {cells.map((d) => {
              const k = toKey(d);
              const cls = ["cal-day", d.getMonth() !== m ? "out" : "", k === value ? "sel" : "", k === todayK ? "today" : ""].join(" ");
              return (
                <button
                  type="button"
                  key={k}
                  className={cls}
                  onClick={() => {
                    onChange(k);
                    setOpen(false);
                  }}
                >
                  {d.getDate()}
                </button>
              );
            })}
          </div>
          <div className="pop-foot">
            <button
              type="button"
              onClick={() => {
                onChange(todayK);
                setOpen(false);
              }}
            >
              Hoje
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function TimePicker({ value, onChange }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  usePopover(open, setOpen, ref);
  const [h, mi] = value ? value.split(":") : ["", ""];

  useEffect(() => {
    if (!open || !ref.current) return;
    ref.current.querySelectorAll(".col").forEach((col) => {
      const el = col.querySelector(".col-item.sel");
      if (el) col.scrollTop = el.offsetTop - col.clientHeight / 2 + el.offsetHeight / 2;
    });
  }, [open]);

  const setH = (n) => onChange(`${pad(n)}:${mi || "00"}`);
  const setM = (n) => onChange(`${h || pad(new Date().getHours())}:${pad(n)}`);

  return (
    <div className="pick" ref={ref}>
      <button type="button" className={"field pick-btn" + (open ? " open" : "")} onClick={() => setOpen(!open)} aria-haspopup="dialog" aria-expanded={open}>
        <span className={value ? "" : "ph"}>{value || "--:--"}</span>
        <Icon name="clock" size={20} />
      </button>
      {open && (
        <div className="pop pop-time" role="dialog" aria-label="Escolher horário">
          <div className="cols">
            <div className="col" aria-label="Hora">
              {Array.from({ length: 24 }, (_, n) => (
                <button type="button" key={n} className={"col-item" + (pad(n) === h ? " sel" : "")} onClick={() => setH(n)}>
                  {pad(n)}
                </button>
              ))}
            </div>
            <span className="col-sep">:</span>
            <div className="col" aria-label="Minuto">
              {Array.from({ length: 60 }, (_, n) => (
                <button type="button" key={n} className={"col-item" + (pad(n) === mi ? " sel" : "")} onClick={() => setM(n)}>
                  {pad(n)}
                </button>
              ))}
            </div>
          </div>
          <div className="pop-foot split">
            <button
              type="button"
              onClick={() => {
                onChange("");
                setOpen(false);
              }}
            >
              Limpar
            </button>
            <button type="button" onClick={() => setOpen(false)}>
              OK
            </button>
          </div>
        </div>
      )}
    </div>
  );
}


function AddSheet({ defaultDate, initial, onSave, onVoice, onClose }) {
  const editing = !!initial;
  const [text, setText] = useState(initial?.text ?? "");
  const [date, setDate] = useState(initial?.date ?? defaultDate);
  const [time, setTime] = useState(initial?.time ?? "");
  const ref = useRef(null);
  useEffect(() => ref.current?.focus(), []);
  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const submit = (e) => {
    e.preventDefault();
    if (!text.trim() || !date) return;
    onSave({ text: cap(text.trim()), date, time });
  };

  return (
    <div className="overlay" role="dialog" aria-label={editing ? "Editar lembrete" : "Novo lembrete"}>
      <form className="panel" onSubmit={submit}>
        <h2 className="panel-title">{editing ? "Editar lembrete" : "Novo lembrete"}</h2>
        <div className="field-row">
          <input
            ref={ref}
            className="field grad-border"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="O que você precisa lembrar?"
            maxLength={140}
          />
          {onVoice && (
            <button type="button" className="icon-btn" onClick={onVoice} aria-label="Ditar por voz">
              <Icon name="mic" />
            </button>
          )}
        </div>
        <div className="two">
          <div className="lbl">
            <span>Data</span>
            <DatePicker value={date} onChange={setDate} />
          </div>
          <div className="lbl">
            <span>Horário</span>
            <TimePicker value={time} onChange={setTime} />
          </div>
        </div>
        {editing ? (
          <div className="row-btns">
            <button className="btn ghost" type="button" onClick={onClose}>
              Cancelar
            </button>
            <button className="btn primary" type="submit" disabled={!text.trim() || !date}>
              Salvar
            </button>
          </div>
        ) : (
          <button className="btn primary wide" type="submit" disabled={!text.trim() || !date}>
            Adicionar lembrete
          </button>
        )}
      </form>
    </div>
  );
}

/* ------------------------- popup de confirmação ------------------------- */
function ConfirmDialog({ title, detail, message, confirmLabel, onConfirm, onCancel }) {
  const cancelRef = useRef(null);
  useEffect(() => {
    cancelRef.current?.focus(); // foco no "Cancelar" para evitar exclusão sem querer
    const onKey = (e) => e.key === "Escape" && onCancel();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div className="overlay confirm" role="alertdialog" aria-modal="true" aria-labelledby="cf-title" onClick={onCancel}>
      <div className="panel" onClick={(e) => e.stopPropagation()}>
        <h2 id="cf-title" className="panel-title">{title}</h2>
        {detail && <p className="cf-detail">{detail}</p>}
        <p className="cf-msg">{message}</p>
        <div className="row-btns">
          <button ref={cancelRef} className="btn ghost" onClick={onCancel}>
            Cancelar
          </button>
          <button className="btn danger" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------ item da lista ------------------------------ */
function Item({ r, leaving, onToggle, onEdit, onRemove }) {
  return (
    <li className={"item" + (r.done ? " done" : "") + (leaving ? " leaving" : "")} onClick={() => onToggle(r.id)}>
      <button
        className={"check" + (r.done ? " on" : "")}
        role="checkbox"
        aria-checked={r.done}
        aria-label={`Marcar “${r.text}” como ${r.done ? "pendente" : "concluído"}`}
      >
        {r.done && <Icon name="check" size={14} />}
      </button>
      <div className="item-body">
        <p>{r.text}</p>
      </div>
      {r.time && <span className="item-time">{r.time}</span>}
      <div className="actions">
        <button className="del" onClick={(e) => { e.stopPropagation(); onEdit(r); }} aria-label={`Editar “${r.text}”`}>
          <Icon name="edit" size={18} />
        </button>
        <button className="del" onClick={(e) => { e.stopPropagation(); onRemove(r.id); }} aria-label={`Excluir “${r.text}”`}>
          <Icon name="trash" size={18} />
        </button>
      </div>
    </li>
  );
}

/* ------------------- botões flutuantes (sem caixa de texto) ------------------- */
function Composer({ active, onOpenForm, onVoice, onClose }) {
  return (
    <div className={"composer" + (active ? " active" : "")}>
      <div className="c-actions">
        <button
          type="button"
          className="c-send"
          onClick={active ? onClose : onOpenForm}
          aria-label={active ? "Fechar" : "Novo lembrete"}
        >
          <Icon name={active ? "x" : "plus"} size={22} />
        </button>
        {!active && (
          <>
            <span className="c-sep" aria-hidden="true" />
            <button type="button" className="c-btn" onClick={onVoice} aria-label="Adicionar por voz">
              <Icon name="mic" size={22} />
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/* ------------------------- notificação do sistema ------------------------- */
// ponte do APK gerado pelo freewebtoapk (só existe dentro do app Android)
const bridge = () => (typeof window !== "undefined" ? window.WebToApk || null : null);
const numId = (id) => {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) | 0;
  return Math.abs(h) % 2147483647 || 1;
};
const dueMs = (r) => new Date(`${r.date}T${r.time}:00`).getTime();

function askNotifPermission() {
  try {
    const b = bridge();
    if (b) {
      if (b.requestNotificationPermission) b.requestNotificationPermission();
      return;
    }
    if ("Notification" in window && Notification.permission === "default") Notification.requestPermission();
  } catch {
    /* noop */
  }
}

async function notifyDevice(body, id) {
  try {
    if (bridge()) return; // no APK, o aviso é agendado pelo sistema Android
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    const opts = {
      body,
      icon: "/assets/logo.png",
      badge: "/assets/logo.png",
      tag: id,
      renotify: true,
      vibrate: [200, 100, 200],
    };
    const reg = "serviceWorker" in navigator ? await navigator.serviceWorker.getRegistration() : null;
    if (reg) await reg.showNotification("Lembrei", opts); // Android + Windows
    else new Notification("Lembrei", opts); // fallback desktop
  } catch (e) {
    console.error("Notificação:", e);
  }
}

/* --------------------------------- app --------------------------------- */
/* ------------------------------- tema salvo ------------------------------- */
// guarda em localStorage e também em cookie (alguns APKs/webviews perdem o localStorage ao fechar)
const THEME_KEY = "lembrei:theme";
function readTheme() {
  try {
    const s = localStorage.getItem(THEME_KEY);
    if (s === "light" || s === "dark") return s;
  } catch {
    /* armazenamento indisponível */
  }
  try {
    const m = document.cookie.match(/(?:^|; )lembrei_theme=(light|dark)/);
    if (m) return m[1];
  } catch {
    /* noop */
  }
  return "dark";
}
function saveTheme(t) {
  try {
    localStorage.setItem(THEME_KEY, t);
  } catch {
    /* noop */
  }
  try {
    document.cookie = `lembrei_theme=${t}; max-age=31536000; path=/; SameSite=Lax`;
  } catch {
    /* noop */
  }
}
// aplica o último tema antes de desenhar a tela, para não piscar o tema errado ao abrir
if (typeof document !== "undefined") document.documentElement.dataset.theme = readTheme();

export default function Lembrei() {
  const { items, loaded, add, toggle, update, remove, clearDone } = useReminders();
  const [now, setNow] = useState(() => new Date());
  const name = "Jakson";
  const [logoOk, setLogoOk] = useState(true);
  const [selected, setSelected] = useState(() => toKey(new Date()));
  const [mode, setMode] = useState(null); // null | "add" | "voice"
  const [view, setView] = useState("home"); // "home" | "today" | "done"
  const [editing, setEditing] = useState(null); // lembrete em edição
  const [confirm, setConfirm] = useState(null); // { type: "one", item } | { type: "all" }
  const [leaving, setLeaving] = useState(null); // id (ou "all") do item que está saindo com animação

  // tema claro/escuro (lembra a escolha; o padrão é o escuro)
  const [theme, setTheme] = useState(readTheme);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    saveTheme(theme);
  }, [theme]);
  const toggleTheme = () => {
    const root = document.documentElement;
    root.classList.add("theme-anim"); // transição suave das cores durante a troca
    setTimeout(() => root.classList.remove("theme-anim"), 450);
    setTheme((t) => (t === "light" ? "dark" : "light"));
  };
  const notified = useRef(new Set());

  // título da aba
  useEffect(() => {
    document.title = "Lembrei";
  }, []);

  // altura visível de verdade (sem a área coberta pelo teclado): o app inteiro passa a ter essa altura,
  // então a caixa de texto fica sempre acima do teclado, no APK e no navegador
  useEffect(() => {
    const vv = window.visualViewport;
    const root = document.documentElement;
    const sync = () => {
      const h = vv ? vv.height : window.innerHeight;
      root.style.setProperty("--vvh", `${Math.round(h)}px`);
      if (window.scrollY || (vv && vv.offsetTop)) window.scrollTo(0, 0);
    };
    sync();
    window.addEventListener("resize", sync);
    if (vv) {
      vv.addEventListener("resize", sync);
      vv.addEventListener("scroll", sync);
    }
    return () => {
      window.removeEventListener("resize", sync);
      if (vv) {
        vv.removeEventListener("resize", sync);
        vv.removeEventListener("scroll", sync);
      }
      root.style.removeProperty("--vvh");
    };
  }, []);

  // relógio
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 15000);
    return () => clearInterval(t);
  }, []);

  const todayKey = toKey(now);
  const days = useMemo(() => Array.from({ length: 21 }, (_, i) => addDays(fromKey(todayKey), i)), [todayKey]);

  // alerta quando chega a hora de um lembrete
  const primed = useRef(false);
  useEffect(() => {
    if (!loaded) return;
    const hm = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
    // na primeira carga, lembretes que já passaram não devem disparar aviso
    const first = !primed.current;
    primed.current = true;
    items.forEach((r) => {
      if (r.done || !r.time || r.date !== todayKey || notified.current.has(r.id)) return;
      if (first) {
        if (r.time <= hm) notified.current.add(r.id);
        return;
      }
      if (r.time <= hm) {
        notified.current.add(r.id);
        notifyDevice(r.text, r.id);
      }
    });
  }, [now, items, todayKey, loaded]);

  // Android (APK): agenda os lembretes no sistema, para tocarem com o app fechado
  const scheduled = useRef(null);
  useEffect(() => {
    const b = bridge();
    if (!b || !loaded) return;
    try {
      const want = new Map();
      items.forEach((r) => {
        if (r.done || !r.time) return;
        const at = dueMs(r);
        if (at > Date.now()) want.set(r.id, { at, text: r.text, sig: `${r.text}|${at}` });
      });
      if (scheduled.current === null) {
        b.cancelAllNotifications(); // primeira sincronização: recomeça do zero
        scheduled.current = new Map();
      }
      scheduled.current.forEach((_, id) => {
        if (!want.has(id)) {
          b.cancelNotification(numId(id));
          scheduled.current.delete(id);
        }
      });
      want.forEach((w, id) => {
        if (scheduled.current.get(id) !== w.sig) {
          b.scheduleNotification(numId(id), "Lembrei", w.text, String(w.at), "none");
          scheduled.current.set(id, w.sig);
        }
      });
    } catch (e) {
      console.error("Agendamento:", e);
    }
  }, [items, loaded]);

  // todas as tarefas, separadas por data e, dentro de cada data, por período do dia
  const sections = useMemo(() => {
    const byDate = {};
    items.forEach((i) => (byDate[i.date] = byDate[i.date] || []).push(i));
    return Object.keys(byDate)
      .sort()
      .map((date) => {
        const sorted = byDate[date].sort(
          (x, y) =>
            Number(x.done) - Number(y.done) ||
            (x.time || "99:99").localeCompare(y.time || "99:99") ||
            x.createdAt - y.createdAt
        );
        return {
          date,
          groups: [{ id: "all", label: "", range: "", list: sorted }],
        };
      });
  }, [items]);
  const hasItems = useMemo(() => new Set(items.filter((i) => !i.done).map((i) => i.date)), [items]);
  const totalDone = items.filter((i) => i.done).length;

  // tela "hoje"
  const todayGroups = useMemo(() => sections.find((x) => x.date === todayKey)?.groups || [], [sections, todayKey]);
  const todayItems = useMemo(() => items.filter((i) => i.date === todayKey), [items, todayKey]);
  const todayDone = todayItems.filter((i) => i.done).length;
  const todayPending = todayItems.length - todayDone;
  const baseDate = view === "today" ? todayKey : selected; // data padrão de novos lembretes

  const scrollToDay = (key) => {
    setTimeout(() => document.getElementById("day-" + key)?.scrollIntoView({ behavior: "smooth", block: "start" }), 80);
  };
  const pickDay = (key) => {
    setSelected(key);
    scrollToDay(key);
  };

  const doneAll = useMemo(() => items.filter((i) => i.done), [items]);
  const doneGroups = useMemo(() => {
    const map = {};
    doneAll.forEach((i) => (map[i.date] = map[i.date] || []).push(i));
    return Object.keys(map)
      .sort((a, b) => b.localeCompare(a))
      .map((date) => ({
        date,
        list: map[date].sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0)),
      }));
  }, [doneAll]);

  const handleSave = async ({ text, date, time }) => {
    if (time) askNotifPermission();
    const item = await add({ text, date, time });
    if (time && new Date(`${date}T${time}:00`) <= new Date()) notified.current.add(item.id);
    setSelected(date);
    setMode(null);
    if (view === "today" && date === todayKey) return;
    if (view === "today") setView("home");
    scrollToDay(date);
  };

  const closeAll = useCallback(() => {
    setMode(null);
    setEditing(null);
  }, []);

  const openEdit = (r) => {
    setEditing(r);
    setMode("edit");
  };

  const handleEditSave = async ({ text, date, time }) => {
    if (!editing) return;
    if (time) askNotifPermission();
    await update(editing.id, { text, date, time });
    // se mudou data/hora, o alerta pode disparar de novo
    notified.current.delete(editing.id);
    if (time && new Date(`${date}T${time}:00`) <= new Date()) notified.current.add(editing.id);
    closeAll();
    if (view === "done") return;
    if (view === "today" && date === todayKey) return;
    if (view === "today") setView("home");
    setSelected(date);
    scrollToDay(date);
  };

  const askRemove = (idOrItem) => {
    const id = typeof idOrItem === "object" ? idOrItem.id : idOrItem;
    const item = items.find((i) => i.id === id);
    if (item) setConfirm({ type: "one", item });
  };
  const cancelConfirm = useCallback(() => setConfirm(null), []);
  const doConfirm = async () => {
    const c = confirm;
    setConfirm(null);
    if (!c) return;
    const wait = () => new Promise((res) => setTimeout(res, 260)); // tempo da animação de saída
    if (c.type === "one") {
      notified.current.delete(c.item.id);
      setLeaving(c.item.id);
      await wait();
      await remove(c.item.id);
    } else {
      setLeaving("all");
      await wait();
      await clearDone();
    }
    setLeaving(null);
  };


  return (
    <>
      <style>{CSS}</style>
      {/* gradiente compartilhado pelos ícones (fora de display:none para funcionar em todas as telas) */}
      <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true" focusable="false">
        <defs>
          <linearGradient id="lembrei-grad" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="24" y2="24">
            <stop offset="0%" stopColor="#f58fd0" />
            <stop offset="55%" stopColor="#f3aab9" />
            <stop offset="100%" stopColor="#f6c8a4" />
          </linearGradient>
        </defs>
      </svg>
      <div className="stage">
        <main className="app">
          {view === "today" && (
            <div className="scroll">
              <section className={"page" + (todayGroups.length === 0 ? " is-empty" : "")}>
                <div className="page-head">
                  <button className="back" onClick={() => setView("home")} aria-label="Voltar">
                    <Icon name="back" size={22} />
                  </button>
                  <div className="ph-title">
                    <h1>hoje</h1>
                    <span className="muted">
                      {cap(now.toLocaleDateString("pt-BR", { weekday: "long", day: "numeric", month: "long" }))}
                    </span>
                  </div>
                </div>

                {todayItems.length > 0 && (
                  <div className="progress">
                    <div className="bar" role="progressbar" aria-valuemin={0} aria-valuemax={todayItems.length} aria-valuenow={todayDone}>
                      <i style={{ width: `${(todayDone / todayItems.length) * 100}%` }} />
                    </div>
                    <span className="muted">
                      {todayDone} de {todayItems.length} concluídos
                    </span>
                  </div>
                )}

                {todayGroups.length === 0 ? (
                  !loaded ? null : <ul className="list">
                    <li className="empty">
                      <p>Nada marcado para hoje.</p>
                      <span>Toque no + ou no microfone para adicionar.</span>
                    </li>
                  </ul>
                ) : (
                  todayGroups.map((g) => (
                    <div className="group" key={g.id}>
                      {g.label && (
                        <p className="group-label">
                          {g.label}
                          {g.range && <span> · {g.range}</span>}
                        </p>
                      )}
                      <ul className="list">
                        {g.list.map((r) => (
                          <Item key={r.id} r={r} leaving={leaving === r.id || (leaving === "all" && r.done)} onToggle={toggle} onEdit={openEdit} onRemove={askRemove} />
                        ))}
                      </ul>
                    </div>
                  ))
                )}
              </section>
            </div>
          )}

          {view === "done" && (
            <div className="scroll">
              <section className={"page" + (doneGroups.length === 0 ? " is-empty" : "")}>
                <div className="page-head">
                  <button className="back" onClick={() => setView("home")} aria-label="Voltar">
                    <Icon name="back" size={22} />
                  </button>
                  <h1>concluídos</h1>
                  {doneAll.length > 0 && (
                    <button
                      className="btn ghost mini"
                      onClick={() => setConfirm({ type: "all" })}
                    >
                      Limpar tudo
                    </button>
                  )}
                </div>

                {doneGroups.length === 0 ? (
                  !loaded ? null : <ul className="list">
                    <li className="empty">
                      <img className="empty-img" src="/assets/icone_mensagem.png" alt="" onError={(e) => (e.currentTarget.style.display = "none")} />
                      <p>Nenhum lembrete concluído.</p>
                      <span>Marque um lembrete como feito e ele aparece aqui.</span>
                    </li>
                  </ul>
                ) : (
                  doneGroups.map((g) => (
                    <div className="group" key={g.date}>
                      <p className="group-label">{dateLabel(g.date)}</p>
                      <ul className="list">
                        {g.list.map((r) => (
                          <Item key={r.id} r={r} leaving={leaving === r.id || (leaving === "all" && r.done)} onToggle={toggle} onEdit={openEdit} onRemove={askRemove} />
                        ))}
                      </ul>
                    </div>
                  ))
                )}
              </section>
            </div>
          )}

          <div className="home" hidden={view !== "home"}>
            <div className="home-top">
            <div className="content">
              <header className="head">
                <div className="head-left">
                  <div className={"avatar" + (logoOk ? " img" : "")} aria-hidden="true">
                    {logoOk ? (
                      <img src="/assets/logo.png" alt="" onError={() => setLogoOk(false)} />
                    ) : (
                      name.charAt(0).toUpperCase()
                    )}
                  </div>
                  <div className="head-text">
                  <p className="hello">{greeting(now)}</p>
                  <p className="name">{name}</p>
                  </div>
                </div>
                <div className="head-right">
                  <button className="done-btn" onClick={() => setView("today")} aria-label={`Ver tarefas de hoje (${todayPending} pendentes)`}>
                    <Icon name="calendar" size={22} />
                    {todayPending > 0 && <span className="badge" key={todayPending}>{todayPending > 99 ? "99+" : todayPending}</span>}
                  </button>
                  <button className="done-btn" onClick={() => setView("done")} aria-label={`Ver concluídos (${doneAll.length})`}>
                    <Icon name="done" size={22} />
                    {doneAll.length > 0 && <span className="badge" key={doneAll.length}>{doneAll.length > 99 ? "99+" : doneAll.length}</span>}
                  </button>
                  <button
                    className="done-btn"
                    onClick={toggleTheme}
                    aria-label={theme === "light" ? "Usar tema escuro" : "Usar tema claro"}
                  >
                    <span className="theme-ico" key={theme}>
                      <Icon name={theme === "light" ? "moon" : "sun"} size={22} />
                    </span>
                  </button>
                </div>
              </header>

              <div className="sec-head">
                <span className="muted">
                  {items.length > 0 ? `${totalDone}/${items.length} concluídos` : dateLabel(selected)}
                </span>
              </div>
            </div>
            </div>

            <div className="scroll">
            <div className="content">
              <section className={"list-sec" + (sections.length === 0 ? " is-empty" : "")}>

                {sections.length === 0 ? (
                  !loaded ? null : <ul className="list">
                    <li className="empty">
                      <img className="empty-img" src="/assets/icone_mensagem.png" alt="" onError={(e) => (e.currentTarget.style.display = "none")} />
                      <p>Nenhum lembrete ainda.</p>
                      <span>Toque no + ou no microfone para adicionar.</span>
                    </li>
                  </ul>
                ) : (
                  sections.map((sec) => {
                    const label = dateLabel(sec.date);
                    const fixed = ["Hoje", "Amanhã", "Ontem"].includes(label);
                    const d = fromKey(sec.date);
                    return (
                      <div className="day-sec" id={"day-" + sec.date} key={sec.date}>
                        <h2 className="day-title">
                          {fixed ? label : cap(d.toLocaleDateString("pt-BR", { weekday: "long" }))}
                          <span>{d.toLocaleDateString("pt-BR", { day: "numeric", month: "long" })}</span>
                        </h2>
                        {sec.groups.map((g) => (
                          <div className="group" key={g.id}>
                            {g.label && (
                              <p className="group-label">
                                {g.label}
                                {g.range && <span> · {g.range}</span>}
                              </p>
                            )}
                            <ul className="list">
                              {g.list.map((r) => (
                                <Item key={r.id} r={r} leaving={leaving === r.id || (leaving === "all" && r.done)} onToggle={toggle} onEdit={openEdit} onRemove={askRemove} />
                              ))}
                            </ul>
                          </div>
                        ))}
                      </div>
                    );
                  })
                )}
              </section>
            </div>
            </div>
          </div>

          {mode === "add" && (
            <AddSheet defaultDate={baseDate} onSave={handleSave} onVoice={() => setMode("voice")} onClose={closeAll} />
          )}
          {mode === "edit" && editing && (
            <AddSheet key={editing.id} defaultDate={baseDate} initial={editing} onSave={handleEditSave} onClose={closeAll} />
          )}
          {mode === "voice" && <VoiceOverlay name={name} defaultDate={baseDate} onSave={handleSave} />}

          {confirm && (
            <ConfirmDialog
              title={confirm.type === "one" ? "Excluir lembrete?" : "Excluir todos os concluídos?"}
              detail={
                confirm.type === "one"
                  ? confirm.item.text
                  : `${doneAll.length} ${doneAll.length === 1 ? "lembrete concluído" : "lembretes concluídos"}`
              }
              message="Essa ação não pode ser desfeita."
              confirmLabel={confirm.type === "one" ? "Excluir" : "Excluir tudo"}
              onConfirm={doConfirm}
              onCancel={cancelConfirm}
            />
          )}

          {view !== "done" && (
            <>
              <div className="dock-fade" aria-hidden="true" />
              <Composer
                active={!!mode}
                onOpenForm={() => setMode("add")}
                onVoice={() => setMode("voice")}
                onClose={closeAll}
              />
            </>
          )}
        </main>
      </div>
    </>
  );
}

/* --------------------------------- estilos --------------------------------- */
const CSS = `
:root{
  --page:#ececec; --card:#141415; --surface:#1e1e20; --surface2:#2a2a2d;
  --text:#f4f4f5; --muted:#8b8b92; --line:rgba(255,255,255,.08);
  --grad:linear-gradient(135deg,#f58fd0 0%,#f3aab9 55%,#f6c8a4 100%);
}
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
html,body,#root{height:100%}
body{display:block;background:var(--card);font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text','SF Pro Display','Helvetica Neue',system-ui,sans-serif;color:var(--text);-webkit-font-smoothing:antialiased}
#root{max-width:none;margin:0;padding:0;text-align:left}
button{font:inherit;color:inherit;background:none;border:0;cursor:pointer}
input,textarea,select{font:inherit;color:inherit}
:focus-visible{outline:2px solid #f58fd0;outline-offset:2px}

.stage{height:var(--vvh,100dvh);display:flex;align-items:flex-start;justify-content:center;overflow:hidden;background:var(--card)}
.app{position:relative;width:100%;height:100%;background:var(--card);overflow:hidden;display:flex;flex-direction:column}
[hidden]{display:none!important}
.scroll{flex:1;overflow-y:auto;overscroll-behavior:contain;padding:max(28px,env(safe-area-inset-top)) 20px 170px}
.home{flex:1;min-height:0;display:flex;flex-direction:column}
.home[hidden]{display:none}
.home-top .head{margin-bottom:8px}
.home-top .sec-head{margin-bottom:2px}
.home-top{flex:none;padding:max(16px,env(safe-area-inset-top)) 20px 0;background:var(--card);position:relative;z-index:20}
.home .scroll{padding-top:44px}
.home-top::after{content:"";position:absolute;left:0;right:0;top:100%;height:48px;pointer-events:none;background:linear-gradient(to bottom,var(--card) 25%,rgba(20,20,21,0))}
.content{display:block}

/* cabeçalho */
.head{display:flex;justify-content:space-between;align-items:center;gap:16px;margin-bottom:22px}
.hello{font-size:clamp(22px,6vw,28px);font-weight:300;line-height:1.15}
.name,.name-input{font-size:clamp(22px,6vw,28px);font-weight:600;line-height:1.2;text-align:left;max-width:100%}
.name{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.name-input{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:2px 10px;width:100%}
.avatar img{width:100%;height:100%;object-fit:contain;display:block}
.avatar.img{background:transparent;border-radius:0;overflow:visible;width:68px;height:68px}
.avatar{flex:none;width:56px;height:56px;border-radius:18px;overflow:hidden;background:#f4f4f5;color:#141415;display:grid;place-items:center;font-size:26px;font-weight:600}

.head-left{display:flex;align-items:center;gap:14px;min-width:0;flex:1}
.head-text{min-width:0}
.head-right{display:flex;align-items:center;gap:12px;flex:none}
.done-btn{position:relative;width:48px;height:48px;border-radius:50%;background:var(--surface);box-shadow:0 1px 0 rgba(255,255,255,.05) inset,0 0 0 1px rgba(255,255,255,.035),0 2px 4px rgba(0,0,0,.35),0 8px 18px -2px rgba(0,0,0,.55);display:grid;place-items:center;color:#dcdce0;transition:background .15s}
.done-btn:hover{background:var(--surface2)}
.badge{position:absolute;top:-3px;right:-3px;min-width:20px;height:20px;padding:0 6px;border-radius:999px;background:var(--grad);color:#17171a;font-size:11px;font-weight:600;display:grid;place-items:center}

/* página de concluídos */
.page{max-width:760px;margin:0 auto}
.ph-title{flex:1;min-width:0}
.ph-title h1{font-size:clamp(22px,6vw,28px);font-weight:500;line-height:1.15}
.progress{display:flex;flex-direction:column;gap:8px;margin:0 4px 26px}
.bar{height:8px;border-radius:999px;background:var(--surface2);overflow:hidden}
.bar i{display:block;height:100%;background:var(--grad);border-radius:999px;transition:width .3s}
.page-head{display:flex;align-items:center;gap:14px;margin-bottom:22px}
.page-head h1{flex:1;font-size:clamp(22px,6vw,28px);font-weight:500}
.back{flex:none;width:48px;height:48px;border-radius:50%;background:var(--surface);display:grid;place-items:center}
.back:hover{background:var(--surface2)}
.btn.mini{padding:9px 16px;font-size:14px;border-radius:14px}
.day-sec{margin-bottom:30px;scroll-margin-top:16px}
.day-title{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;font-size:21px;font-weight:500;margin:0 6px 14px}
.day-title span{font-size:13px;font-weight:300;color:var(--muted)}
.group{margin-bottom:22px}
.group-label{font-size:15px;font-weight:500;color:#dcdce0;margin:0 6px 10px}
.group-label span{font-weight:300;color:var(--muted);font-size:13px}

/* dias */
.dates{display:flex;gap:10px;overflow-x:auto;margin:0 -20px 26px;padding:2px 20px;scrollbar-width:none}
.dates::-webkit-scrollbar{display:none}
.day{position:relative;flex:none;width:68px;height:68px;border-radius:50%;background:var(--surface);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1px;transition:transform .15s}
.day b{font-size:19px;font-weight:600}
.day span{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.02em}
.day.sel{background:var(--grad);color:#17171a;transform:scale(1.06)}
.day.sel span{color:rgba(23,23,26,.7)}
.day .dot{position:absolute;bottom:7px;width:4px;height:4px;border-radius:50%;background:#f58fd0}

/* lista */
.sec-head{display:flex;justify-content:space-between;align-items:baseline;gap:12px;margin-bottom:14px;padding:0 4px}
.sec-head .muted{margin-left:auto}
.muted{color:var(--muted);font-size:14px}
.list{list-style:none;background:var(--surface);border-radius:28px;padding:10px 8px;box-shadow:0 1px 0 rgba(255,255,255,.04) inset,0 0 0 1px rgba(255,255,255,.035),0 2px 4px rgba(0,0,0,.35),0 12px 28px -4px rgba(0,0,0,.6),0 28px 56px -12px rgba(0,0,0,.55)}
.item{display:flex;align-items:center;gap:14px;padding:13px 12px;border-radius:18px;cursor:pointer;user-select:none;-webkit-user-select:none}
.item + .item{border-top:1px solid var(--line);border-radius:0}
.item-body{flex:1;min-width:0;display:flex;flex-direction:column;align-items:flex-start;gap:6px}
.item-body p{font-size:16px;line-height:1.35;overflow-wrap:anywhere;color:#e7e7ea}
.item.done .item-body p{text-decoration:line-through;color:var(--muted)}
.item.done .chip{opacity:.5}
.item-time{flex:none;font-size:13px;font-weight:500;color:var(--muted);font-variant-numeric:tabular-nums;background:var(--surface2);border-radius:999px;padding:4px 11px;margin-right:4px}
.item.done .item-time{opacity:.5}
.check{flex:none;width:22px;height:22px;margin-top:0;border-radius:7px;border:1.6px solid #5d5d64;display:grid;place-items:center;color:#17171a;transition:background .15s,border-color .15s}
.check.on{background:var(--grad);border-color:transparent}
.actions{flex:none;display:flex;align-items:center;gap:2px}
.row-btns{display:flex;gap:10px}
.row-btns .btn{flex:1}
.del{flex:none;width:34px;height:34px;border-radius:50%;display:grid;place-items:center;color:#5d5d64;transition:color .15s,background .15s}
.del:hover{background:rgba(255,255,255,.05)}
.del:hover svg,.del:focus-visible svg{stroke:url(#lembrei-grad)}
.empty{padding:34px 18px;text-align:center}
.empty-img{display:block;width:96px;height:96px;object-fit:contain;margin:0 auto 14px}
.empty p{font-size:16px;margin-bottom:6px}
.empty span{font-size:14px;color:var(--muted)}
.chip{display:inline-block;background:var(--surface2);border-radius:999px;padding:5px 12px;font-size:13px;color:#dcdce0}
.chip.small{padding:2px 10px;font-size:12px;color:var(--muted)}

/* caixa de texto estilo prompt */
.dock-fade{position:absolute;left:0;right:0;bottom:0;height:150px;z-index:15;pointer-events:none;background:linear-gradient(to top,var(--card) 30%,rgba(20,20,21,0))}
.composer{position:absolute;z-index:30;left:0;right:0;margin:0 auto;bottom:max(24px,calc(env(safe-area-inset-bottom) + 12px));width:fit-content;display:flex;align-items:center;justify-content:center;gap:6px;background:rgba(40,40,44,.72);-webkit-backdrop-filter:blur(22px) saturate(1.4);backdrop-filter:blur(22px) saturate(1.4);border:0;border-radius:999px;padding:6px;box-shadow:0 18px 50px rgba(0,0,0,.55),0 2px 10px rgba(0,0,0,.35),inset 0 1px 0 rgba(255,255,255,.07);transition:box-shadow .3s ease}
.composer.active input{cursor:default}
.composer:hover,.composer:focus-within{box-shadow:0 18px 50px rgba(0,0,0,.55),0 2px 10px rgba(0,0,0,.35),inset 0 1px 0 rgba(255,255,255,.07),0 0 0 4px rgba(245,143,208,.06),0 0 28px rgba(245,143,208,.22),0 0 60px rgba(246,200,164,.10)}
.composer input{flex:1;min-width:0;background:none;border:0;outline:none;font-size:16px;padding:8px 0}
.composer input::placeholder{color:var(--muted)}
.c-btn{flex:none;width:42px;height:42px;border-radius:50%;display:grid;place-items:center;color:#dcdce0;transition:transform .15s,background .15s,color .15s}
.c-actions{flex:none;display:flex;align-items:center;gap:4px;padding:4px;border-radius:999px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.08);box-shadow:inset 0 1px 0 rgba(255,255,255,.04)}
.c-sep{flex:none;width:1px;height:22px;background:rgba(255,255,255,.14);margin:0 2px}
.c-btn:hover,.c-btn:focus-visible,.c-btn:active{background:var(--grad);color:#17171a}
.c-btn:active{transform:scale(.94)}
.c-send{flex:none;width:42px;height:42px;border-radius:50%;background:transparent;color:#dcdce0;display:grid;place-items:center;transition:transform .15s,background .15s,color .15s}
.c-send:hover,.c-send:focus-visible,.c-send:active{background:var(--grad);color:#17171a}
.c-send:active{transform:scale(.94)}

/* camadas (voz / novo) */
.overlay{position:absolute;inset:0;z-index:20;display:flex;align-items:center;justify-content:center;padding:max(24px,env(safe-area-inset-top)) 18px 120px;background:rgba(10,10,11,.62);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);overflow-y:auto;animation:fade .2s ease}
.panel{width:100%;max-width:440px;margin:auto;background:var(--surface);border-radius:30px;padding:26px 24px;box-shadow:0 1px 0 rgba(255,255,255,.05) inset,0 0 0 1px rgba(255,255,255,.05),0 4px 8px rgba(0,0,0,.4),0 24px 60px -6px rgba(0,0,0,.75),0 48px 90px -20px rgba(0,0,0,.6);display:flex;flex-direction:column;gap:20px;animation:panelIn .34s cubic-bezier(.2,.9,.3,1.05) backwards}
.panel-title{font-size:clamp(22px,6vw,26px);font-weight:400;line-height:1.25}
.panel-title strong{font-weight:600}
.said{min-height:96px}
.said-text{font-size:clamp(18px,5vw,21px);line-height:1.5;font-weight:300}
.hl{text-decoration:underline;text-decoration-color:#f58fd0;text-decoration-thickness:2px;text-underline-offset:5px;font-weight:400}
.said-hint{font-size:18px;color:#c9c9ce;font-weight:300;line-height:1.5}
.said-hint span{display:block;margin-top:8px;font-size:14px;color:var(--muted)}
.error{margin-top:10px;font-size:14px;line-height:1.4;color:#f3aab9;background:var(--grad);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}
.preview{display:flex;flex-direction:column;gap:12px}
.pv-text{font-size:20px;line-height:1.35;overflow-wrap:anywhere}
.pv-meta{display:flex;gap:8px;flex-wrap:wrap}
.pv-actions{display:flex;gap:10px}
.pv-actions .btn{flex:1}
.typed{display:flex;flex-direction:column;gap:10px}

.mic-wrap{position:relative;align-self:center;width:150px;height:150px;display:grid;place-items:center;margin-top:4px}
.ring{position:absolute;border-radius:50%;border:0;padding:1.5px;background:var(--grad);-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask:linear-gradient(#000 0 0) content-box exclude,linear-gradient(#000 0 0)}
.ring.r1{inset:14px}
.ring.r2{inset:0;opacity:.5}
.ring.on{animation:pulse 1.6s ease-in-out infinite}
.ring.r2.on{animation-delay:.3s}
.mic-btn{width:74px;height:74px;border-radius:50%;background:#fff;color:#141415;display:grid;place-items:center;position:relative;z-index:1}
.mic-btn:disabled{opacity:.4;cursor:not-allowed}

.btn{border-radius:16px;padding:14px 18px;font-size:16px;font-weight:500;transition:transform .15s,opacity .15s}
.btn:active{transform:scale(.97)}
.btn:disabled{opacity:.4;cursor:not-allowed}
.btn.primary{background:var(--grad);color:#fff;font-weight:600;text-shadow:0 1px 2px rgba(120,40,90,.35),0 0 12px rgba(120,40,90,.2)}
.btn.ghost{background:var(--surface2)}
.btn.danger{background:#ef5b73;color:#fff}
.btn.wide{width:100%}

.overlay.confirm{z-index:50;padding-bottom:24px;background:rgba(8,8,9,.72)}
.cf-detail{font-size:17px;line-height:1.4;overflow-wrap:anywhere;background:var(--surface2);padding:12px 14px;border-radius:14px}
.cf-msg{font-size:14px;color:var(--muted);margin-top:-8px}

.field-row{display:flex;gap:10px;align-items:center}
.field{width:100%;background:var(--surface2);border:1px solid transparent;border-radius:16px;padding:14px 16px;font-size:16px;color-scheme:dark;min-width:0}
.field:focus{outline:none;border-color:#f58fd0}
.field.grad-border,.field.grad-border:focus{border:1.5px solid transparent;background:linear-gradient(var(--surface2),var(--surface2)) padding-box,var(--grad) border-box}
.icon-btn{flex:none;width:50px;height:50px;border-radius:16px;background:var(--surface2);display:grid;place-items:center}
.two{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.lbl{display:flex;flex-direction:column;gap:6px;font-size:13px;color:var(--muted)}
.typed .field{background:var(--surface2)}

/* seletores de data e hora */
.pick{position:relative}
.pick-btn{display:flex;align-items:center;justify-content:space-between;gap:10px;text-align:left;cursor:pointer;color:var(--text)}
.pick-btn svg{flex:none;color:#b9b9c0}
.pick-btn .ph{color:var(--muted)}
.pick-btn.open{border-color:#f58fd0}
.pop{position:absolute;z-index:60;top:calc(100% + 8px);left:0;background:#242427;border:1px solid rgba(255,255,255,.08);border-radius:18px;padding:10px;box-shadow:0 1px 0 rgba(255,255,255,.05) inset,0 4px 10px rgba(0,0,0,.4),0 24px 56px -8px rgba(0,0,0,.8);transform-origin:top left;animation:popIn .2s cubic-bezier(.2,.9,.3,1.1) backwards;color:var(--text)}
.pop-date{width:min(232px,calc(100vw - 52px))}
.pop-time{right:0;left:auto;width:148px}
.pop-head{display:flex;align-items:center;justify-content:space-between;margin:0 2px 6px}
.pop-head b{font-size:13.5px;font-weight:600}
.pop-nav{display:flex;gap:4px}
.pop-nav button{width:26px;height:26px;border-radius:50%;display:grid;place-items:center;color:#cfcfd5;transition:background .15s,color .15s}
.pop-nav button:hover{background:var(--grad);color:#17171a}
.cal-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:2px}
.cal-week{margin-bottom:4px}
.cal-week span{text-align:center;font-size:11px;color:var(--muted);padding:3px 0}
.cal-day{aspect-ratio:1;border-radius:50%;display:grid;place-items:center;font-size:12.5px;color:#e7e7ea;transition:background .15s,color .15s}
.cal-day.out{color:#5d5d64}
.cal-day:hover{background:rgba(255,255,255,.08)}
.cal-day.today{box-shadow:inset 0 0 0 1.5px rgba(245,143,208,.7)}
.cal-day.sel{background:var(--grad);color:#17171a;font-weight:600;box-shadow:none}
.pop-foot{display:flex;justify-content:flex-end;margin-top:6px;padding-top:6px;border-top:1px solid var(--line)}
.pop-foot.split{justify-content:space-between}
.pop-foot button{font-size:13px;font-weight:500;padding:4px 10px;border-radius:999px;color:#f58fd0;transition:background .15s}
.pop-foot button:hover{background:rgba(245,143,208,.12)}
.cols{display:flex;align-items:center;gap:6px}
.col{position:relative;flex:1;height:132px;overflow-y:auto;scrollbar-width:none;display:flex;flex-direction:column;gap:2px;padding:4px 0;-webkit-mask-image:linear-gradient(to bottom,transparent,#000 12%,#000 88%,transparent);mask-image:linear-gradient(to bottom,transparent,#000 12%,#000 88%,transparent)}
.col::-webkit-scrollbar{display:none}
.col-item{flex:none;height:30px;border-radius:10px;font-size:14px;color:#a7a7ae;display:grid;place-items:center;transition:background .15s,color .15s}
.col-item:hover{background:rgba(255,255,255,.08);color:var(--text)}
.col-item.sel{background:var(--grad);color:#17171a;font-weight:600}
.col-sep{color:var(--muted);font-weight:600}

/* mensagens vazias centralizadas na vertical */
.scroll>.page.is-empty,.home .scroll>.content{min-height:100%;display:flex;flex-direction:column}
.page.is-empty{width:100%}
.list-sec.is-empty{flex:1;display:flex;flex-direction:column}
.page.is-empty>.list,.list-sec.is-empty>.list{margin:auto 0}

/* animações suaves */
.home:not([hidden]),.page{animation:pageIn .4s cubic-bezier(.2,.8,.2,1) backwards}

.item{animation:itemIn .42s cubic-bezier(.2,.8,.2,1) backwards;transition:background .2s,transform .15s}
.item:nth-child(2){animation-delay:.04s}
.item:nth-child(3){animation-delay:.08s}
.item:nth-child(4){animation-delay:.12s}
.item:nth-child(5){animation-delay:.16s}
.item:nth-child(6){animation-delay:.2s}
.item:nth-child(n+7){animation-delay:.24s}
.item:active{transform:scale(.985);background:rgba(255,255,255,.03)}
.item.leaving{pointer-events:none;overflow:hidden;animation:itemOut .26s cubic-bezier(.4,0,.2,1) forwards}
.item-body p{transition:color .3s}
.item-time{transition:opacity .3s}
.chip{transition:opacity .3s}

.check{transition:background .2s,border-color .2s,transform .15s}
.check.on{animation:checkPop .38s cubic-bezier(.3,1.4,.5,1)}
.check.on svg path{stroke-dasharray:24;animation:draw .28s .06s ease-out backwards}

.done-btn,.back,.icon-btn,.del,.mic-btn{transition:background .15s,transform .15s,color .15s,opacity .15s}
.done-btn:active,.back:active,.icon-btn:active,.mic-btn:active{transform:scale(.92)}
.del:active{transform:scale(.86)}
.badge{animation:badgePop .42s cubic-bezier(.3,1.6,.5,1)}

.btn{transition:transform .15s,opacity .15s,filter .2s,box-shadow .25s}
.btn:not(:disabled):hover{filter:brightness(1.08)}
.btn.primary:not(:disabled):hover{box-shadow:0 8px 24px -6px rgba(245,143,208,.5)}

.cal-day,.col-item{transition:background .15s,color .15s,transform .12s}
.cal-day:active,.col-item:active{transform:scale(.9)}
.pop-time{transform-origin:top right}
/* com um seletor aberto, o botão flutuante fica atrás da camada (e do seletor) */
.app:has(.pop) .composer,.app:has(.pop) .dock-fade{z-index:10}

.empty{animation:rise .5s cubic-bezier(.2,.8,.2,1) backwards}
.empty-img{animation:float 3.6s ease-in-out infinite}
.preview{animation:rise .35s cubic-bezier(.2,.8,.2,1) backwards}
.pv-actions{animation:rise .35s .08s cubic-bezier(.2,.8,.2,1) backwards}

@keyframes itemIn{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
@keyframes itemOut{from{opacity:1;transform:none;max-height:140px}to{opacity:0;transform:translateX(28px);max-height:0;padding-top:0;padding-bottom:0}}
@keyframes checkPop{0%{transform:scale(.8)}60%{transform:scale(1.18)}100%{transform:scale(1)}}
@keyframes draw{from{stroke-dashoffset:24}to{stroke-dashoffset:0}}
@keyframes badgePop{0%{transform:scale(.4);opacity:0}70%{transform:scale(1.2)}100%{transform:scale(1);opacity:1}}
@keyframes pageIn{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}
@keyframes popIn{from{opacity:0;transform:translateY(-6px) scale(.96)}to{opacity:1;transform:none}}
@keyframes panelIn{from{opacity:0;transform:translateY(18px) scale(.96)}to{opacity:1;transform:none}}
@keyframes float{0%,100%{transform:translateY(0)}50%{transform:translateY(-6px)}}
@keyframes composerLift{from{transform:translateY(calc(-50% + 42vh));opacity:.6}to{transform:translateY(-50%);opacity:1}}

/* aviso */
.toast{position:absolute;top:max(14px,env(safe-area-inset-top));left:14px;right:14px;z-index:40;display:flex;align-items:center;gap:12px;background:#f4f4f5;color:#141415;border-radius:20px;padding:12px 14px;box-shadow:0 12px 40px rgba(0,0,0,.4);animation:drop .3s ease;max-width:480px;margin:0 auto}
.toast-ico{flex:none;width:36px;height:36px;border-radius:50%;background:var(--grad);display:grid;place-items:center}
.toast-body{flex:1;min-width:0;display:flex;flex-direction:column;line-height:1.3}
.toast-body span{overflow-wrap:anywhere;font-size:15px}
.toast-x{flex:none;width:32px;height:32px;display:grid;place-items:center;border-radius:50%}

@keyframes pulse{0%,100%{transform:scale(1);opacity:.6}50%{transform:scale(1.14);opacity:1}}
@keyframes fade{from{opacity:0}to{opacity:1}}
@keyframes rise{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}
@keyframes drop{from{opacity:0;transform:translateY(-14px)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}

@media (max-width:420px){
  .avatar{width:50px;height:50px;border-radius:16px;font-size:24px}
  .hello{font-size:18px}
  .name{font-size:20px}
  .head-right{gap:8px}
  .done-btn{width:42px;height:42px}
  .done-btn svg{width:20px;height:20px}
  .avatar.img{width:60px;height:60px}
  .head-left{gap:12px}
  .composer{bottom:max(16px,calc(env(safe-area-inset-bottom) + 8px));gap:4px;padding:5px}
  .c-actions{gap:2px;padding:3px}
  .c-btn,.c-send{width:48px;height:48px}
  .c-btn svg,.c-send svg{width:25px;height:25px}
  .c-sep{height:24px}
  .dock-fade{height:120px}
  .scroll{padding-bottom:140px}
  .list{padding:6px 4px;border-radius:24px}
  .item{padding:9px 8px;gap:10px}
  .item-body{gap:4px}
  .item-body p{font-size:15px}
  .item-time{font-size:11.5px;padding:3px 8px;margin-right:-8px}
  .actions{gap:0}
  .del{width:30px;height:30px}
  .del svg{width:17px;height:17px}
}

/* telas muito pequenas */
@media (max-width:360px){
  .composer{padding:4px}
  .c-btn,.c-send{width:44px;height:44px}
  .c-btn svg,.c-send svg{width:23px;height:23px}
  .c-sep{height:22px}
  .head-right{gap:8px}
  .done-btn{width:42px;height:42px}
  .avatar{width:48px;height:48px;border-radius:16px;font-size:22px}
  .avatar.img{width:56px;height:56px}
  .scroll,.home-top{padding-left:16px;padding-right:16px}
  .dates{margin:0 -16px 22px;padding:2px 16px}
  .day{width:60px;height:60px}
  .two{grid-template-columns:1fr}
}

/* celular: ao tocar na caixa, ela vai para o centro e o resto do app fica desfocado */
.composer-backdrop{display:none}
@media (max-width:639px){
  .composer-backdrop{display:block;position:absolute;inset:0;z-index:25;background:rgba(10,10,11,.55);-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);animation:fade .2s ease}
}

/* tablet: tela cheia, conteúdo centralizado */
@media (min-width:640px){
  .scroll{padding:40px 36px 170px}
  .home-top{padding:24px 36px 0}
  .home .scroll{padding-top:44px}
  .content{max-width:760px;margin:0 auto}
  .dates{margin:0 -36px 28px;padding:2px 36px}
}

/* desktop: conteúdo centralizado em uma coluna */
@media (min-width:1000px){
  .scroll{padding:56px clamp(40px,5vw,96px) 170px}
  .home-top{padding:24px clamp(40px,5vw,96px) 0}
  .home .scroll{padding-top:44px}
  .content{max-width:760px;margin:0 auto;display:block}
  .panel{max-width:480px}
}

/* botão de tema */
.theme-btn{flex:none;align-self:center;width:38px;height:38px;border-radius:50%;background:var(--surface);color:var(--muted);display:grid;place-items:center;box-shadow:0 1px 0 rgba(255,255,255,.05) inset,0 0 0 1px rgba(255,255,255,.035),0 2px 4px rgba(0,0,0,.3);transition:background .15s,transform .15s,color .15s}
.theme-btn:hover{background:var(--surface2);color:var(--text)}
.theme-btn:active{transform:scale(.9)}
.theme-ico{display:grid;place-items:center;animation:themeSpin .5s cubic-bezier(.2,.9,.3,1.2)}
@keyframes themeSpin{from{opacity:0;transform:rotate(-90deg) scale(.5)}to{opacity:1;transform:none}}
.theme-anim,.theme-anim *{transition:background-color .35s ease,color .35s ease,border-color .35s ease,box-shadow .35s ease!important}

/* tema claro */
:root[data-theme="light"]{color-scheme:light;--card:#f3f3f6;--surface:#ffffff;--surface2:#ececf0;--text:#18181b;--muted:#76767f;--line:rgba(0,0,0,.08)}
[data-theme="light"] .home-top::after{background:linear-gradient(to bottom,var(--card) 25%,rgba(243,243,246,0))}
[data-theme="light"] .dock-fade{background:linear-gradient(to top,var(--card) 30%,rgba(243,243,246,0))}

[data-theme="light"] .list{box-shadow:0 0 0 1px rgba(0,0,0,.04),0 2px 4px rgba(20,20,40,.05),0 12px 28px -6px rgba(20,20,40,.10),0 28px 56px -16px rgba(20,20,40,.10)}
[data-theme="light"] .done-btn,[data-theme="light"] .back,[data-theme="light"] .theme-btn{box-shadow:0 0 0 1px rgba(0,0,0,.04),0 2px 4px rgba(20,20,40,.06),0 8px 18px -4px rgba(20,20,40,.12)}
[data-theme="light"] .done-btn{color:#52525b}
[data-theme="light"] .panel{box-shadow:0 0 0 1px rgba(0,0,0,.05),0 4px 8px rgba(20,20,40,.06),0 24px 60px -8px rgba(20,20,40,.22)}
[data-theme="light"] .pop{background:#fff;border-color:rgba(0,0,0,.08);box-shadow:0 4px 10px rgba(20,20,40,.08),0 24px 56px -8px rgba(20,20,40,.25)}

[data-theme="light"] .overlay{background:rgba(236,236,242,.62)}
[data-theme="light"] .overlay.confirm{background:rgba(232,232,238,.72)}
[data-theme="light"] .composer-backdrop{background:rgba(236,236,242,.6)}

[data-theme="light"] .item-body p{color:#27272a}
[data-theme="light"] .item:active{background:rgba(0,0,0,.03)}
[data-theme="light"] .group-label{color:#3f3f46}
[data-theme="light"] .chip:not(.small){color:#3f3f46}
[data-theme="light"] .check:not(.on){border-color:#b9b9c1}
[data-theme="light"] .del{color:#a1a1aa}
[data-theme="light"] .del:hover{background:rgba(0,0,0,.05)}

[data-theme="light"] .composer{background:rgba(255,255,255,.8);box-shadow:0 18px 50px rgba(20,20,40,.18),0 2px 10px rgba(20,20,40,.08),0 0 0 1px rgba(0,0,0,.05),inset 0 1px 0 rgba(255,255,255,.9)}
[data-theme="light"] .composer:hover,[data-theme="light"] .composer:focus-within{box-shadow:0 18px 50px rgba(20,20,40,.18),0 2px 10px rgba(20,20,40,.08),0 0 0 1px rgba(0,0,0,.05),inset 0 1px 0 rgba(255,255,255,.9),0 0 0 4px rgba(245,143,208,.10),0 0 28px rgba(245,143,208,.28),0 0 60px rgba(246,200,164,.18)}
[data-theme="light"] .c-actions{background:rgba(0,0,0,.04);border-color:rgba(0,0,0,.06);box-shadow:none}
[data-theme="light"] .c-sep{background:rgba(0,0,0,.12)}
[data-theme="light"] .c-btn,[data-theme="light"] .c-send{color:#52525b}

[data-theme="light"] .said-hint{color:#52525b}
[data-theme="light"] .mic-btn{background:#18181b;color:#fff}
[data-theme="light"] .btn.primary{color:#2a1022;text-shadow:none}
[data-theme="light"] .field{color-scheme:light}

[data-theme="light"] .pick-btn svg{color:#8b8b95}
[data-theme="light"] .pop-nav button{color:#52525b}
[data-theme="light"] .cal-day:not(.sel){color:#27272a}
[data-theme="light"] .cal-day.out{color:#b4b4bc}
[data-theme="light"] .cal-day:not(.sel):hover{background:rgba(0,0,0,.06)}
[data-theme="light"] .col-item:not(.sel){color:#6b6b74}
[data-theme="light"] .col-item:not(.sel):hover{background:rgba(0,0,0,.06);color:var(--text)}
`;