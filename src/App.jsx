import { useState, useRef, useMemo } from 'react';
import './App.css';

// ───────── Configuración ─────────
// API gratuita de Google Gemini (clave gratis en https://aistudio.google.com/apikey)
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const MODEL = import.meta.env?.VITE_GEMINI_MODEL || 'gemini-2.5-flash'; // acepta imagen y texto

const RESTRICCIONES = ['Vegetariano', 'Vegano', 'Sin gluten', 'Sin lactosa', 'Sin frutos secos', 'Sin mariscos'];
const OBJETIVOS = ['Ganar masa muscular', 'Perder grasa', 'Mantener peso'];
const FACTORES_ACTIVIDAD = { sedentario: 1.2, ligero: 1.375, moderado: 1.55, alto: 1.725, muy_alto: 1.9 };

const SYSTEM_PROMPT =
  'Eres un entrenador personal y nutricionista. Responde en español, de forma clara, estructurada y motivadora. ' +
  'Sé prudente: no des consejo médico, respeta lesiones y condiciones indicadas, y recomienda consultar a un profesional cuando corresponda.';

// ───────── Utilidades ─────────
const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const formatText = (text) => {
  if (!text) return null;
  const html = escapeHtml(text)
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>')
    .replace(/\n/g, '<br/>');
  return <div dangerouslySetInnerHTML={{ __html: html }} />;
};

const clasificarIMC = (v) => {
  if (v == null) return '';
  if (v < 18.5) return 'Bajo peso';
  if (v < 25) return 'Normal';
  if (v < 30) return 'Sobrepeso';
  return 'Obesidad';
};

const resizeImage = (file, max = 1024) =>
  new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const s = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * s);
      c.height = Math.round(img.height * s);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('No se pudo leer la imagen')); };
    img.src = url;
  });

// Llamada a Gemini con streaming (SSE)
async function streamGemini({ apiKey, system, parts, signal, onToken }) {
  const res = await fetch(`${API_BASE}/${MODEL}:streamGenerateContent?alt=sse`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts }],
    }),
    signal,
  });

  if (!res.ok) {
    let detalle = '';
    try { detalle = (await res.json()).error?.message || ''; } catch { /* sin detalle */ }
    if (res.status === 400 || res.status === 403) throw new Error(`Clave de API no válida o sin permiso. ${detalle}`);
    if (res.status === 429) throw new Error('Se alcanzó el límite del plan gratuito. Espera un minuto y reintenta (o mañana si es el límite diario).');
    throw new Error(`Error ${res.status}. ${detalle}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const raw of lines) {
      const line = raw.trim();
      if (!line.startsWith('data:')) continue;
      const json = line.slice(5).trim();
      if (!json || json === '[DONE]') continue;
      const chunk = JSON.parse(json);
      const token = chunk.candidates?.[0]?.content?.parts?.map((x) => x.text || '').join('') || '';
      if (token) { full += token; onToken(full); }
    }
  }
  if (!full) throw new Error('El modelo no devolvió texto (posible bloqueo de seguridad). Prueba con otra foto.');
  return full;
}

const mensajeError = (e) => {
  if (e.name === 'AbortError') return 'Generación cancelada.';
  if (e instanceof TypeError) return 'No se pudo conectar con la API. Revisa tu conexión a internet.';
  return e.message;
};

// ───────── Componente ─────────
export default function App() {
  const [goal, setGoal] = useState('Ganar masa muscular');
  const [weight, setWeight] = useState('');
  const [height, setHeight] = useState('');
  const [muscleMass, setMuscleMass] = useState('');
  const [age, setAge] = useState('');
  const [sex, setSex] = useState('hombre');
  const [activity, setActivity] = useState('moderado');
  const [mealsPerDay, setMealsPerDay] = useState('4');
  const [restricciones, setRestricciones] = useState([]);
  const [salud, setSalud] = useState('');
  const [apiKey, setApiKey] = useState(() => {
    try { return sessionStorage.getItem('gemini_key') || ''; } catch { return ''; }
  });
  const cambiarClave = (v) => {
    setApiKey(v);
    try { sessionStorage.setItem('gemini_key', v); } catch { /* ignorar */ }
  };

  const [photo, setPhoto] = useState(null);
  const [photoPreview, setPhotoPreview] = useState(null);
  const fileInputRef = useRef(null);
  const abortRef = useRef(null);

  const [loading, setLoading] = useState(false);
  const [training, setTraining] = useState('');
  const [diet, setDiet] = useState('');
  const [trainingDone, setTrainingDone] = useState(false);
  const [dietDone, setDietDone] = useState(false);
  const [tab, setTab] = useState('training');
  const [formError, setFormError] = useState('');

  const w = Number(weight), h = Number(height), a = Number(age);

  const validar = () => {
    if (!apiKey.trim()) return 'Pega tu clave de API de Google AI Studio (es gratis).';
    if (!weight || !height || !age) return 'Ingresa edad, peso y altura.';
    if (a < 16 || a > 90) return 'La edad debe estar entre 16 y 90 años.';
    if (w < 30 || w > 300) return 'El peso debe estar entre 30 y 300 kg.';
    if (h < 120 || h > 230) return 'La altura debe estar entre 120 y 230 cm.';
    if (muscleMass && (Number(muscleMass) < 5 || Number(muscleMass) > 80)) return 'La masa muscular debe estar entre 5 y 80 %.';
    if (!photo) return 'Sube una foto de tu físico para el análisis visual.';
    return '';
  };

  const imc = weight && height && h > 0 ? Number((w / Math.pow(h / 100, 2)).toFixed(1)) : null;

  const macros = useMemo(() => {
    if (!(w >= 30 && h >= 120 && a >= 16)) return null;
    const base = 10 * w + 6.25 * h - 5 * a + (sex === 'hombre' ? 5 : -161);
    const tdee = base * FACTORES_ACTIVIDAD[activity];
    const avisos = [];

    let ajuste = 0;
    if (goal === 'Ganar masa muscular') ajuste = 300;
    else if (goal === 'Perder grasa') ajuste = -400;
    if (a < 18 && ajuste < 0) {
      ajuste = 0;
      avisos.push('Eres menor de 18 años: no se aplica déficit calórico. Consulta a un profesional.');
    }

    let target = tdee + ajuste;
    const minimo = sex === 'hombre' ? 1500 : 1200;
    if (target < minimo) {
      target = minimo;
      avisos.push(`Se aplicó un mínimo de ${minimo} kcal por seguridad.`);
    }

    const protein = Math.round(w * (goal === 'Perder grasa' ? 2.2 : 2.0));
    const fat = Math.round((target * 0.25) / 9);
    let carbs = Math.round((target - protein * 4 - fat * 9) / 4);
    if (carbs < 50) {
      carbs = 50;
      avisos.push('Con tu peso y objetivo, los carbohidratos quedaron en el mínimo de 50 g.');
    }

    // Calorías reales según los macros finales (coherentes con las barras)
    const total = protein * 4 + fat * 9 + carbs * 4;
    const p = Math.round((protein * 4 / total) * 100);
    const f = Math.round((fat * 9 / total) * 100);
    const c = Math.max(0, 100 - p - f);
    return { tdee: Math.round(tdee), target: total, protein, fat, carbs, percentages: { p, c, f }, avisos };
  }, [w, h, a, sex, activity, goal]);

  const handlePhoto = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) { setFormError('Selecciona un archivo de imagen.'); return; }
    try {
      const dataUrl = await resizeImage(file, 1024);
      setPhotoPreview(dataUrl);
      setPhoto(dataUrl.split(',')[1]);
      setFormError('');
    } catch (err) {
      setFormError(err.message);
    }
  };
  const removePhoto = () => {
    setPhoto(null); setPhotoPreview(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };
  const toggleRestriccion = (r) =>
    setRestricciones((prev) => (prev.includes(r) ? prev.filter((x) => x !== r) : [...prev, r]));

  const cancelar = () => abortRef.current?.abort();

  const generatePlan = async () => {
    const err = validar();
    if (err) { setFormError(err); return; }
    setFormError('');

    setLoading(true);
    setTraining(''); setDiet('');
    setTrainingDone(false); setDietDone(false);
    setTab('training');

    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const { signal } = ctrl;
    let etapa = 'training';

    const perfil =
      `Peso: ${weight} kg, Altura: ${height} cm, Edad: ${age} años, Sexo: ${sex}. ` +
      (muscleMass ? `Masa muscular: ${muscleMass}%. ` : '') +
      `IMC: ${imc} (${clasificarIMC(imc)}). Objetivo: ${goal}. Nivel de actividad: ${activity}. ` +
      (salud.trim() ? `Lesiones/condiciones médicas: ${salud.trim()}.` : 'Sin lesiones ni condiciones declaradas.');

    const macroTexto = macros
      ? `Objetivo calórico: ~${macros.target} kcal. Proteína: ~${macros.protein}g, Grasas: ~${macros.fat}g, Carbohidratos: ~${macros.carbs}g.`
      : '';
    const restriccionesTexto = restricciones.length
      ? `Restricciones: ${restricciones.join(', ')}.`
      : 'Sin restricciones.';

    try {
      // 1) Entrenamiento (con la foto)
      const trainingPrompt = `Datos del usuario: ${perfil}

Se adjunta una foto del usuario. Empieza con el título **Observaciones de la foto (aproximadas)** y 2-4 frases prudentes sobre complexión y postura. Si algo no se ve con claridad, dilo; no inventes ni diagnostiques. Los datos numéricos tienen prioridad sobre la foto.

Después escribe **Plan de entrenamiento** semanal acorde a su objetivo, nivel y limitaciones. Para CADA día usa esta estructura:
**Día X: [Grupo muscular]**
- **Calentamiento:** [breve descripción]
- **Ejercicios:**
  - [Nombre] (Series x Reps)
    *Técnica:* [1-2 frases]
    *Consejo:* [error común a evitar]
- **Enfriamiento:** [breve descripción]

Sé conciso y usa lenguaje sencillo.`;

      await streamGemini({
        apiKey: apiKey.trim(),
        system: SYSTEM_PROMPT,
        signal,
        parts: [{ text: trainingPrompt }, { inlineData: { mimeType: 'image/jpeg', data: photo } }],
        onToken: setTraining,
      });
      setTrainingDone(true);

      // 2) Dieta
      etapa = 'diet';
      const dietPrompt = `Datos del usuario: ${perfil}
${macroTexto}
${restriccionesTexto}
Comidas al día: ${mealsPerDay}.

Dame un plan de alimentación SEMANAL (lunes a domingo) con desayuno, comida, cena y snacks según el número de comidas. Alimentos en gramos, ajustado a los macros indicados. Incluye lista de la compra.`;

      await streamGemini({
        apiKey: apiKey.trim(),
        system: SYSTEM_PROMPT,
        signal,
        parts: [{ text: dietPrompt }],
        onToken: setDiet,
      });
      setDietDone(true);
    } catch (e) {
      console.error(e);
      const msg = `❌ ${mensajeError(e)}`;
      if (etapa === 'diet') setDiet((prev) => (prev ? `${prev}\n\n${msg}` : msg));
      else setTraining((prev) => (prev ? `${prev}\n\n${msg}` : msg));
    } finally {
      setLoading(false);
      abortRef.current = null;
    }
  };

  const textoActual = tab === 'training' ? training : diet;

  const copiar = () => navigator.clipboard?.writeText(textoActual.replace(/\*/g, ''));
  const descargar = () => {
    const blob = new Blob([textoActual.replace(/\*/g, '')], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const el = document.createElement('a');
    el.href = url;
    el.download = tab === 'training' ? 'entrenamiento.txt' : 'dieta.txt';
    el.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="entrenador-app">
      <header className="app-header">
        <div className="badge">✨ IA gratuita en la nube · Google Gemini</div>
        <h1>Lleva tu entrenamiento al siguiente nivel</h1>
        <p>Genera planes de nutrición y rutinas personalizadas a partir de tus datos y una foto, con IA gratuita de Google Gemini.</p>
        <p className="disclaimer">
          Herramienta orientativa. No sustituye el consejo de un médico, entrenador o nutricionista titulado,
          especialmente si tienes lesiones, estás embarazada o tienes alguna condición de salud. Tu foto y tus datos se envían a Google para generar el plan: no subas nada que no quieras compartir.
        </p>
      </header>

      <main className="app-container">
        <section className="card">
          <div className="form-group api-key-box">
            <label htmlFor="apikey">Clave de API de Google Gemini (gratis)</label>
            <input id="apikey" type="password" autoComplete="off" value={apiKey}
              onChange={(e) => cambiarClave(e.target.value)} placeholder="Pega aquí tu clave" />
            <small className="hint">
              Créala gratis en <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">aistudio.google.com/apikey</a>.
              Se guarda solo en esta pestaña y nunca en el código.
            </small>
          </div>

          <div className="section-title"><div className="step-num">1</div><h2>Tu objetivo</h2></div>
          <div className="segmented-control">
            {OBJETIVOS.map((o) => (
              <button key={o} type="button" aria-pressed={goal === o}
                className={`segment-btn ${goal === o ? 'active' : ''}`} onClick={() => setGoal(o)}>
                {o}
              </button>
            ))}
          </div>

          <div className="section-title"><div className="step-num">2</div><h2>Datos personales</h2></div>
          <div className="sex-toggle">
            <button type="button" aria-pressed={sex === 'hombre'} className={`sex-btn ${sex === 'hombre' ? 'active' : ''}`} onClick={() => setSex('hombre')}>Hombre</button>
            <button type="button" aria-pressed={sex === 'mujer'} className={`sex-btn ${sex === 'mujer' ? 'active' : ''}`} onClick={() => setSex('mujer')}>Mujer</button>
          </div>

          <div className="input-grid">
            <div className="form-group">
              <label htmlFor="age">Edad</label>
              <input id="age" type="number" min="16" max="90" value={age} onChange={(e) => setAge(e.target.value)} placeholder="Ej. 28" />
            </div>
            <div className="form-group">
              <label htmlFor="weight">Peso (kg)</label>
              <input id="weight" type="number" min="30" max="300" value={weight} onChange={(e) => setWeight(e.target.value)} placeholder="Ej. 80" />
            </div>
            <div className="form-group">
              <label htmlFor="height">Altura (cm)</label>
              <input id="height" type="number" min="120" max="230" value={height} onChange={(e) => setHeight(e.target.value)} placeholder="Ej. 175" />
            </div>
            <div className="form-group">
              <label htmlFor="muscle">Masa muscular (%)</label>
              <input id="muscle" type="number" min="5" max="80" value={muscleMass} onChange={(e) => setMuscleMass(e.target.value)} placeholder="Opcional" />
            </div>
            <div className="form-group">
              <label htmlFor="activity">Nivel de actividad</label>
              <select id="activity" value={activity} onChange={(e) => setActivity(e.target.value)}>
                <option value="sedentario">Sedentario</option>
                <option value="ligero">Ligero</option>
                <option value="moderado">Moderado</option>
                <option value="alto">Alto</option>
                <option value="muy_alto">Muy alto</option>
              </select>
            </div>
            <div className="form-group">
              <label htmlFor="meals">Comidas al día</label>
              <select id="meals" value={mealsPerDay} onChange={(e) => setMealsPerDay(e.target.value)}>
                <option value="3">3 comidas</option>
                <option value="4">4 comidas</option>
                <option value="5">5 comidas</option>
              </select>
            </div>
          </div>

          <div className="form-group">
            <label htmlFor="salud">Lesiones o condiciones médicas (opcional)</label>
            <textarea id="salud" rows={2} value={salud} onChange={(e) => setSalud(e.target.value)}
              placeholder="Ej. dolor de rodilla, diabetes, alergia a la soja…" />
          </div>

          <div className="section-title"><div className="step-num">3</div><h2>Restricciones alimentarias</h2></div>
          <div className="chips-container">
            {RESTRICCIONES.map((r) => (
              <button key={r} type="button" aria-pressed={restricciones.includes(r)}
                className={`chip ${restricciones.includes(r) ? 'active' : ''}`} onClick={() => toggleRestriccion(r)}>
                {r}
              </button>
            ))}
          </div>

          <div className="section-title"><div className="step-num">4</div><h2>Foto de tu físico</h2></div>
          <input ref={fileInputRef} type="file" accept="image/*" onChange={handlePhoto} hidden />
          {photoPreview ? (
            <div className="upload-zone">
              <div className="preview-wrapper">
                <img src={photoPreview} alt="Vista previa de tu foto" className="photo-preview" />
                <div className="preview-actions">
                  <span className="model-tag">🤖 {MODEL}</span>
                  <button type="button" className="btn-remove-photo" onClick={removePhoto}>Eliminar foto</button>
                </div>
              </div>
            </div>
          ) : (
            <button type="button" className="upload-zone required" onClick={() => fileInputRef.current?.click()}>
              <span className="upload-icon" aria-hidden="true">📸</span>
              <p>Haz clic para subir una foto</p>
              <small>Se redimensiona aquí y se envía a Google para el análisis</small>
            </button>
          )}

          {formError && <p className="form-error" role="alert">{formError}</p>}

          {loading ? (
            <button type="button" className="btn-gradient btn-cancel" onClick={cancelar}>⏹ Cancelar generación</button>
          ) : (
            <button type="button" className="btn-gradient" onClick={generatePlan}>✨ Generar plan personalizado</button>
          )}
        </section>

        <section className="results-column">
          {macros && (
            <>
              <div className="metrics-grid">
                <div className="metric-card calories">
                  <span className="metric-title">Calorías objetivo</span>
                  <span className="metric-number">{macros.target} <span className="metric-unit">kcal</span></span>
                  <span className="metric-sub">Consumo diario (mantenimiento: {macros.tdee})</span>
                </div>
                <div className="metric-card imc">
                  <span className="metric-title">Índice de masa corporal</span>
                  <span className="metric-number">{imc}</span>
                  <span className="metric-sub">{clasificarIMC(imc)}</span>
                </div>
              </div>

              {macros.avisos.length > 0 && (
                <div className="card warning-card" role="status">
                  {macros.avisos.map((m) => <p key={m}>⚠️ {m}</p>)}
                </div>
              )}

              <div className="card macros-card">
                <h3>Distribución de macronutrientes</h3>
                <div className="macros-bars">
                  {[
                    ['Proteína', macros.protein, macros.percentages.p, 'fill-protein'],
                    ['Carbohidratos', macros.carbs, macros.percentages.c, 'fill-carbs'],
                    ['Grasas', macros.fat, macros.percentages.f, 'fill-fat'],
                  ].map(([name, g, pct, cls]) => (
                    <div className="macro-row" key={name}>
                      <div className="macro-info">
                        <span className="macro-name">{name}</span>
                        <span className="macro-val">{g}g ({pct}%)</span>
                      </div>
                      <div className="progress-bg">
                        <div className={`progress-fill ${cls}`} style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}

          {training || diet ? (
            <div className="card">
              <div className="tabs-header" role="tablist">
                <button type="button" role="tab" aria-selected={tab === 'training'}
                  className={`tab-btn ${tab === 'training' ? 'active' : ''}`} onClick={() => setTab('training')}>
                  🏋️ Entrenamiento {trainingDone && '✓'}
                </button>
                <button type="button" role="tab" aria-selected={tab === 'diet'}
                  className={`tab-btn ${tab === 'diet' ? 'active' : ''}`} onClick={() => setTab('diet')}>
                  🥗 Dieta semanal {dietDone && '✓'}
                </button>
              </div>
              <div className="formatted-output" aria-live="polite">
                {textoActual ? formatText(textoActual) : <p className="muted">Se generará después del entrenamiento…</p>}
              </div>
              {textoActual && !loading && (
                <div className="export-actions">
                  <button type="button" className="chip" onClick={copiar}>Copiar</button>
                  <button type="button" className="chip" onClick={descargar}>Descargar .txt</button>
                </div>
              )}
            </div>
          ) : (
            <div className="card empty-state">
              <span aria-hidden="true">👈</span>
              <p>Completa tus datos, sube tu foto y genera tu plan para ver los resultados aquí.</p>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
