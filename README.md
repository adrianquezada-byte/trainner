# Entrenador IA

Planes de entrenamiento y dieta personalizados con la API gratuita de Google Gemini.

## Uso local
```bash
npm install
npm run dev
```
Abre la URL que muestra la terminal y pega tu clave gratis de https://aistudio.google.com/apikey

## Publicar en GitHub Pages
1. Sube el proyecto a un repositorio de GitHub (rama `main`).
2. En **Settings → Pages**, en **Source** elige **GitHub Actions**.
3. Cada `git push` a `main` publica la app automáticamente.

## Importante
- Nunca escribas tu clave de API en el código. Cada usuario la pega en la página.
- La foto y los datos se envían a Google para generar el plan.
- Herramienta orientativa: no sustituye a un médico ni a un nutricionista.
