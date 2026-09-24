import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { api } from '../api'
import { listenOnce, speak } from '../voice'

/**
 * ASK COPS: floating AI assistant available on every page.
 * Text or voice in, text (and optionally speech) out. Answers are grounded in the
 * operator's live data; buttons in replies jump to the right tab.
 */
const AskCops = forwardRef(function AskCops({ opId, machineId, lang, walkaroundDone, onNavigate }, ref) {
  const [open, setOpen] = useState(false)
  const [msgs, setMsgs] = useState([{ role: 'assistant', content: "Hi! I'm ASK COPS. Ask me anything about your shift, your machine or how to use COPS.", source: 'intro' }])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [listening, setListening] = useState(false)
  const [voiceOut, setVoiceOut] = useState(true)
  const [suggestions, setSuggestions] = useState([])
  const listRef = useRef(null)

  useEffect(() => { api.askSuggestions().then(setSuggestions).catch(() => {}) }, [])
  useEffect(() => { listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' }) }, [msgs, open])

  const send = async (text, { speakAnswer = voiceOut } = {}) => {
    const q = text.trim()
    if (!q || busy) return
    setOpen(true)
    setInput('')
    const history = msgs.filter((m) => m.source !== 'intro').map(({ role, content }) => ({ role, content }))
    setMsgs((m) => [...m, { role: 'user', content: q }])
    setBusy(true)
    try {
      const r = await api.ask({ operator_id: opId, machine_id: machineId, message: q, history, lang, walkaround_done: walkaroundDone })
      setMsgs((m) => [...m, { role: 'assistant', content: r.answer, actions: r.actions, source: r.source }])
      if (speakAnswer) speak(r.answer.replace(/[•⚠️🛑]/g, ''), { lang: /[ऀ-ॿ]/.test(r.answer) ? 'hi-IN' : 'en-IN', force: true })
    } catch (e) {
      setMsgs((m) => [...m, { role: 'assistant', content: `Sorry, I couldn't reach the COPS server (${e.message}).`, source: 'error' }])
    } finally {
      setBusy(false)
    }
  }

  // Let the global voice button route free-form questions here.
  useImperativeHandle(ref, () => ({ ask: (q) => send(q, { speakAnswer: true }), open: () => setOpen(true) }))

  const mic = () => {
    if (listening) return
    setListening(true)
    let finalText = ''
    listenOnce({
      lang,
      onResult: (t, isFinal) => { setInput(t); if (isFinal) finalText = t },
      onEnd: () => { setListening(false); if (finalText) send(finalText, { speakAnswer: true }) },
      onError: () => setListening(false),
    })
  }

  const lastSource = [...msgs].reverse().find((m) => m.source === 'claude' || m.source === 'offline')?.source

  return (
    <>
      {!open && (
        <button className="askcops-fab" onClick={() => setOpen(true)} title="ASK COPS: AI assistant">
          <span style={{ fontSize: 22 }}>💬</span><span>ASK COPS</span>
        </button>
      )}
      {open && (
        <div className="askcops-panel card">
          <div className="row askcops-head">
            <div className="brand-mark" style={{ width: 30, height: 30, fontSize: 11, animation: 'none' }}>AI</div>
            <div>
              <b>ASK COPS</b>
              <div className="small muted">{lastSource === 'claude' ? '🟢 Claude AI · grounded in your live data' : '🟢 On-device assistant · works offline'}</div>
            </div>
            <div className="spacer" />
            <button className={`btn sm ghost ${voiceOut ? '' : 'muted'}`} onClick={() => { setVoiceOut(!voiceOut); window.speechSynthesis?.cancel() }} title="Read answers aloud">{voiceOut ? '🔊' : '🔇'}</button>
            <button className="btn sm ghost" onClick={() => { setOpen(false); window.speechSynthesis?.cancel() }} aria-label="Close">✕</button>
          </div>
          <div className="askcops-list" ref={listRef}>
            {msgs.map((m, i) => (
              <div key={i} className={`bubble ${m.role}`}>
                <div style={{ whiteSpace: 'pre-wrap' }}>{m.content}</div>
                {m.actions?.length > 0 && (
                  <div className="row wrap" style={{ gap: 6, marginTop: 8 }}>
                    {m.actions.map((a) => <button key={a.label} className="btn sm" onClick={() => onNavigate?.(a.tab)}>{a.label} →</button>)}
                  </div>
                )}
              </div>
            ))}
            {busy && <div className="bubble assistant muted">Thinking…</div>}
          </div>
          {msgs.length <= 2 && (
            <div className="row wrap askcops-suggest">
              {suggestions.map((s) => <button key={s} className="btn sm ghost" onClick={() => send(s)}>{s}</button>)}
            </div>
          )}
          <form className="row askcops-input" onSubmit={(e) => { e.preventDefault(); send(input) }}>
            <input type="text" value={input} onChange={(e) => setInput(e.target.value)} placeholder={lang === 'hi-IN' ? 'कुछ भी पूछिए…' : 'Ask anything… e.g. "Is my hydraulic oil OK?"'} />
            <button type="button" className={`btn round ${listening ? 'danger mic live' : ''}`} onClick={mic} aria-label="Speak">🎙️</button>
            <button type="submit" className="btn primary" disabled={busy || !input.trim()}>Send</button>
          </form>
        </div>
      )}
    </>
  )
})

export default AskCops
