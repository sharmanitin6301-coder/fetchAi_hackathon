# AccessFix

> **AccessFix is an AI agent that browses a web page like a blind keyboard-only user, finds barriers, fixes the code, and proves the fix by re-running the agent.**

---

## 🚀 How It Works

Traditional accessibility tools generate static PDF reports that sit in developer backlogs for months. AccessFix introduces a closed-loop, task-driven repair pipeline:

1. **Scanner**: Executes an automated Axe WCAG audit and extracts the full accessibility snapshot (`ariaSnapshot`).
2. **Task Discovery**: Infers the single most important task a visitor comes to the page to accomplish (e.g., *"Subscribe to the newsletter with an email"*).
3. **Blind Agent**: Simulates a blind user navigating strictly via keyboard (`Tab`, `Shift+Tab`, `Enter`, `Space`, `Type:<text>`) and accessibility tree announcements (`{ role, name }`). If an element traps focus or is unreachable, the agent detects it and halts.
4. **Prioritizer**: Scores and ranks detected barriers deterministically by user impact (task-blocking barriers score +100, Axe critical +40, serious +30), tagging user types (blind, low-vision, keyboard-only).
5. **Fixer**: Resolves unambiguous selectors and synthesizes semantic HTML and CSS repairs (deterministic contrast stepping, `:focus-visible` styling, `<button>` transformations, labels, landmarks, alt text).
6. **Verifier**: Executes an iterative verification loop on an isolated working copy (up to 3 rounds). Measures pixel-level bounding-box layout shifts ($> 5\text{px}$) and re-runs the Blind Agent to mathematically verify that the task now succeeds.
7. **Report & Proof**: Generates a unified code `.diff`, live before/after sandboxed previews, Web Speech screen-reader vocalization, and routes ambiguous items to a human triage queue.

```
                  [ Web Page / URL ]
                          │
                          ▼
                     ┌─────────┐
                     │ Scanner │ (Axe WCAG audit + accessibility tree)
                     └────┬────┘
                          ▼
                  ┌───────────────┐
                  │ Task Discovery│ (Infers primary user goal)
                  └───────┬───────┘
                          ▼
                   ┌─────────────┐
                   │ Blind Agent │ (Keyboard-only traversal; detects trap)
                   └──────┬──────┘
                          ▼
                   ┌─────────────┐
                   │ Prioritizer │ (Scores barriers: task blockers +100)
                   └──────┬──────┘
                          ▼
                      ┌───────┐     Iterative Verification Loop (Max 3 rounds)
                  ┌──►│ Fixer │◄─────────────────────────────────────────────┐
                  │   └───┬───┘                                              │
                  │       ▼                                                  │
                  │  ┌──────────┐                                            │
                  │  │ Verifier │ (Bounding-box layout check + Re-run Agent)─┘
                  │  └────┬─────┘
                  │       │ (Passed)
                  ▼       ▼
              ┌────────────────┐
              │ Report & Proof │ (Unified .diff + Audio + Before/After Previews)
              └────────────────┘
```

---

## ⚡ Quick Start in 5 Lines

```bash
git clone https://github.com/your-org/accessfix.git && cd accessfix
npm install
npx playwright install chromium
cp .env.example .env # Add your GEMINI_API_KEY (or GROQ_API_KEY)
node server.js       # Open http://localhost:3000
```

---

## 🧪 Reproducing the Demo

AccessFix includes self-contained demo fixtures in `demo-sites/` designed to demonstrate real-world accessibility failures and automated repairs.

### 1. Broken Fixture (`demo-sites/broken.html`)
The default fixture models an artisanal coffee newsletter page with 6 planted accessibility barriers:
- **Missing alt text** on the hero coffee image
- **Nameless icon button** closing the promo banner
- **Unlabelled email input** (placeholder only)
- **Low-contrast helper text** (`#aaa` on `#ffffff`, ~2.3:1 ratio)
- **Fatal keyboard trap**: The "Subscribe" button is an unlabelled `<div>` with an `onclick` handler—completely unreachable and unactivatable via keyboard
- **Broken page structure**: Missing `lang="en"`, missing `<main>` and landmark regions, and an `<h4>` immediately following an `<h1>`

**Steps to run:**
1. Open `http://localhost:3000`.
2. Leave target path as `demo-sites/broken.html`.
3. Click **"Run AccessFix"**.
4. Observe the initial Blind Agent run get trapped at step 12.
5. Watch AccessFix synthesize 11 semantic operations, rebuild the working copy, and re-run the Blind Agent—completing the task in **5 steps with 0 remaining Axe violations**.
6. Inspect the generated unified diff, before/after preview frames, and simulated screen-reader audio phrases.

### 2. Verified Fixed Fixture (`demo-sites/fixed.html`)
To confirm that compliant pages pass cleanly:
1. In the target input, type `demo-sites/fixed.html`.
2. Click **"Run AccessFix"**.
3. Observe 0 violations detected, and the Blind Agent immediately achieving the goal in 5 steps.

### 3. Running Offline / Cached Demo (`DEMO_CACHE=true`)
For hackathon presentations or offline environments with unreliable Wi-Fi:
- **Option A (UI Checkbox):** Keep the **"Use cached demo"** checkbox checked in the dashboard.
- **Option B (Environment Variable):** Set `DEMO_CACHE=true` in your `.env` file.

In cached mode, the server makes **zero network or LLM calls** and does not launch Chromium. It replays the verified execution stream from `cache/broken/run.json` over Server-Sent Events with realistic delays (0.5s–2.0s per stage), making it 100% immune to network outages.

---

## 📸 Screenshots

| Original Broken Fixture (`cache/broken/before.png`) |
| :---: |
| ![Original Broken Newsletter Fixture](cache/broken/before.png) |
| *Visual appearance looks polished, but the Subscribe control is a keyboard-inaccessible `<div>` with unlabelled inputs and poor contrast.* |

---

## 🛠️ Tech Stack

- **Runtime & Architecture:** Node.js (ES Modules)
- **Browser Automation & Auditing:** [Playwright](https://playwright.dev/) & [@axe-core/playwright](https://github.com/dequelabs/axe-core-npm/tree/develop/packages/playwright)
- **Primary AI Intelligence:** Google Gemini (`@google/genai`)
- **Resilient AI Fallback:** Groq (`groq-sdk`) / OpenRouter for automatic failover during 503s or rate limits
- **Server & SSE Streaming:** Express 5
- **DOM Parsing & Code Patching:** [Cheerio](https://cheerio.js.org/) & [jsdiff](https://github.com/kpdecker/jsdiff)
- **Accessible Speech & Transcripts:** Web Speech API & [JSDOM](https://github.com/jsdom/jsdom)

---

## 🛡️ Honest Limitations

- **Automation Cannot Catch Everything:** WCAG automated tools typically detect only 30%–40% of accessibility issues. AccessFix focuses on the most critical, task-blocking barriers (unlabelled buttons, missing form labels, missing alt text, keyboard navigation traps, heading hierarchies, and contrast). Subjective design choices and nuanced usability items are routed to the **"Needs a Human"** triage queue.
- **Human Developer Review Required:** AccessFix outputs unified `.diff` patches applied to an isolated working copy. Patches should always be reviewed and approved by engineering and design teams before deploying to production.
- **Privacy & LLM Usage:** Free-tier and commercial LLM API endpoints may log or process prompts. Do not audit private, authenticated, or sensitive internal applications with public or free-tier API keys.
- **Layout Shift Safeguards:** While our Playwright layout engine flags any element shift greater than 5 pixels, visual regression testing in complex responsive viewports should still be validated by human designers.
