# AccessFix — 3-Minute Demo Pitch Script

**Format:** 3:00 Pitch + Live Demo  
**Audience:** Hackathon Judges & Technical Reviewers  
**Goal:** Demonstrate autonomous, closed-loop accessibility verification and code repair with verifiable proof.

---

## ⏱️ Timeline & Stage Directions

```
[0:00 - 0:25] ── Slide 1-3: The Hook & The Broken Reality
[0:25 - 1:20] ── Slide 4 & Dashboard: The Live Run (Agent Trapped → Fixed)
[1:20 - 2:20] ── Dashboard: The Proof (Diff, Audio, Before/After)
[2:20 - 2:35] ── Slide 6: Radical Honesty (Human Triage)
[2:35 - 3:00] ── Slide 6: Vision & Close
```

---

### [0:00 - 0:25] Hook & Problem (Slides 1 → 2)

**What to do / click:**
- Display **Slide 1** (`pitch/slides.html`).
- Advance to **Slide 2** using the Right Arrow key.

**What to say:**
> *"Meet a blind user trying to sign up for this weekly newsletter. To sighted users, the page looks completely normal. But when a screen-reader user tabs down, the 'Subscribe' button isn't a button at all—it’s an unlabelled `<div>` with an onclick handler. The user is trapped. They can never subscribe.*
>
> *Over 1 billion people live with disabilities. Today, the ADA and the European Accessibility Act make accessibility an urgent legal requirement. Yet 97% of top websites still fail basic WCAG standards.*
>
> *Why? Because today’s tools only REPORT problems. They generate 50-page PDF audits that pile up in backlogs. No tool actually fixes the code, and no tool proves the user can now complete their goal."*

---

### [0:25 - 1:20] The Solution & Live Run (Slides 3 → 4 → Dashboard)

**What to do / click:**
- Advance to **Slide 3** (Solution) for 5 seconds.
- Advance to **Slide 4** (LIVE DEMO) and press **`T`** to start the 3-minute timer.
- Switch browser tab to the AccessFix Dashboard at `http://localhost:3000`.
- Confirm target is `demo-sites/broken.html`.
- Click **"Run AccessFix"** (or keep "Use cached demo" checked for instant zero-latency demo).

**What to say:**
> *"We built AccessFix. The premise is simple: Paste a URL. An AI agent attempts a real user goal using only a keyboard and accessibility tree. It gets stuck, our pipeline synthesizes semantic code fixes, the agent re-runs, and it succeeds. You get verifiable proof.*
>
> *Let's watch it live.* [Click 'Run AccessFix']
>
> *Step 1: The scanner audits the page with Axe and records the accessibility tree.*  
> *Step 2: Task discovery infers the user's primary goal: 'Subscribe to newsletter with an email'.*  
> *Step 3: Our Blind Agent launches. It tabs through the page. Notice step 12—it focuses the input 4 times and detects an inescapable loop. The Subscribe control cannot be reached. Initial run FAILS.*  
> *Step 4 & 5: AccessFix prioritizes task-blocking barriers, generates semantic HTML and CSS repairs, and verifies the layout."*

*(If live AI provider is slow or experiencing latency, say the backup line:)*
> 💬 **Backup Line:**  
> *"Live AI is taking a few seconds—switching to our saved run. It’s the exact same deterministic pipeline, streaming the recorded execution."*

---

### [1:20 - 2:20] The Proof: Metrics, Code Diff & Audio (Dashboard)

**What to do / click:**
- Point to the **Result Banner**: `✓ Task completed in 5 steps`.
- Point to **Metrics**: `Axe Violations: 7 → 0`, `Agent Steps: 12 (Failed) → 5 (Passed)`.
- Click the **"Code Diff"** tab.
- Click the **"Live Preview"** tab to show before/after side-by-side.
- Click the **"Hear It"** tab and click **"Play 'After' Audio"**.

**What to say:**
> *"Look at the results:*  
> *• Axe violations dropped from 7 down to 0.*  
> *• The Blind Agent went from getting stuck at step 12 to successfully completing the task in just 5 steps.*
>
> *Under 'Code Diff', you can see the precise, non-destructive patch: the fake `div` was converted into a semantic `<button type="button">`, the input received an explicit `<label>`, contrast was adjusted using mathematical luminance stepping, and missing landmarks were added.*
>
> *Under 'Live Preview', our layout engine measured every bounding box before and after—preserving visual design down to single-pixel thresholds.*
>
> *And under 'Hear It', you can listen to how a screen reader now hears clean, informative prompts instead of silent, unlabelled traps."*

---

### [2:20 - 2:35] Radical Honesty: The Human Review Triage (Dashboard → Slide 6)

**What to do / click:**
- Click the **"Needs a Human"** tab on the dashboard.
- Switch back to `pitch/slides.html` and advance to **Slide 6** (Impact & Honesty).

**What to say:**
> *"Here is what sets AccessFix apart: radical honesty.*  
> *Automation cannot catch everything. We fix common, blocking semantic issues, and we flag the rest for humans.*
>
> *Notice our 'Needs a Human' tab. Any visual shift greater than 5 pixels, or ambiguous design decisions like outline colors, are flagged for human sign-off rather than hallucinating false compliance."*

---

### [2:35 - 3:00] Close & Next Steps (Slide 6)

**What to do / click:**
- Highlight the roadmap cards on **Slide 6**.
- Click **"Download Patch"** in the dashboard or show the downloaded `.diff` file.

**What to say:**
> *"With one click, developers can download the unified `.diff` file and apply it directly to their codebase.*
>
> *What’s next?*  
> *1. A GitHub Action that gates pull requests on verified keyboard task completion.*  
> *2. A browser extension that acts as a runtime accessibility polyfill for disabled users on broken sites.*  
> *3. Expanding to multi-step flows like shopping cart checkouts.*
>
> *AccessFix moves web accessibility from passive PDF complaints to active, verifiable code repair. Thank you!"*

---

## 💡 Quick Tips for the Presenter

1. **Keep the demo moving:** Don't wait on live LLM APIs if network is slow—toggle **"Use cached demo"** on the dashboard; it streams the exact same SSE stages.
2. **Emphasize the Agent:** Remind judges that Axe only checks static HTML rules, while AccessFix proves whether a user can actually complete a task.
3. **Download button:** Show the "Download Patch" button—judges love seeing a real `.diff` ready to commit with `git apply`.
