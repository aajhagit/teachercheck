# TeacherCheck ✎

> **"Your words. Your personality. Just fix the English."**

TeacherCheck is an old-school grammar correction web application designed for students, non-native English speakers, developers, creators, and everyday writers.

Unlike generic AI rewriters that sanitize your text into sterile corporate prose, TeacherCheck preserves your authentic voice, contractions, slang, and emojis — correcting only genuine English mistakes with the tactile feeling of a school teacher's red pen.

---

## Features

- **Nostalgic School Notebook Identity**: Tactile cream paper, blue ruled lines, red margin, and handwritten red-pen annotations (Newsreader and Caveat typography).
- **Red Pen Strike-Through & Word-Above Annotations**: Mistakes are struck through in red ink with the correction rendered directly above the word.
- **Genuine Error Correction**: Fixes actual grammar, verb agreement, and tense mistakes without policing casual expressions or slang.
- **Teacher's Notes & Positive Stamps**: Explains the grammar rule concisely with an encouraging teacher remark.
- **Production Hardened**:
  - IP-based sliding window rate limiter on `/api/check`
  - Strict input validation (10KB payload limit, string typing, 600-character cap)
  - Content Security Policy (CSP), clickjacking protection (`X-Frame-Options: DENY`), `X-Content-Type-Options: nosniff`
  - 10-second provider timeout with offline rule fallback
  - Standalone production Node.js server (`server/prodServer.js`) with SPA routing for `/app`

---

## Tech Stack

- **Frontend**: Vanilla HTML5, CSS3, Modern ES JavaScript (Zero heavy UI dependencies)
- **Bundler**: Vite 5
- **Backend**: Node.js HTTP Server (`server/prodServer.js`)
- **AI Engine**: Google Gemini API (`generativelanguage.googleapis.com`) with rule-based offline fallback

---

## Local Development

1. **Clone the repository**:
   ```bash
   git clone https://github.com/aajhagit/teachercheck.git
   cd teachercheck
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Configure environment variables**:
   Create a `.env` file in the root directory (see `.env.example`):
   ```env
   GEMINI_API_KEY=your_gemini_api_key_here
   PORT=3000
   CHECK_RATE_LIMIT_WINDOW_MS=900000
   CHECK_RATE_LIMIT_MAX=30
   ```

4. **Run development server**:
   ```bash
   npm run dev
   ```

5. **Build & run production server**:
   ```bash
   npm run build
   npm start
   ```

---

## Deployment on Render

This project is configured to run as a single Node.js Web Service on [Render](https://render.com):

- **Runtime**: `Node`
- **Build Command**: `npm install && npm run build`
- **Start Command**: `npm start`
- **Environment Variables**:
  - `GEMINI_API_KEY`: *(your Google AI Studio key)*
  - `NODE_ENV`: `production`

---

## License

MIT
