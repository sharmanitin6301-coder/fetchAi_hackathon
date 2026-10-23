"""
AccessFix Agentverse Hosted Agent Adapter
=========================================
Bridges Fetch.ai Agentverse / ASI:One chat with the AccessFix autonomous
accessibility repair and verification pipeline.

Implements the official Agent Chat Protocol (ACP) via `uagents_core.contrib.protocols.chat`.
"""

import os
import sys
import time
import json
import re
import logging
from datetime import datetime, timezone
from uuid import uuid4

# Load environment variables if python-dotenv is present, with manual fallback
try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

# Direct .env fallback if environment variables remain unset
if not os.getenv("ACCESSFIX_AGENT_TOKEN"):
    for env_path in [
        os.path.join(os.path.dirname(__file__), "..", ".env"),
        os.path.join(os.getcwd(), ".env"),
    ]:
        if os.path.exists(env_path):
            with open(env_path, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if line and not line.startswith("#") and "=" in line:
                        k, v = line.split("=", 1)
                        k, v = k.strip(), v.strip().strip("'\"")
                        if k and not os.getenv(k):
                            os.environ[k] = v
            break

# HTTP request client: prefer `requests` as specified, with graceful stdlib fallback
try:
    import requests
except ImportError:
    requests = None
    import urllib.request
    import urllib.error

# uagents and Agent Chat Protocol (ACP) imports
try:
    from uagents import Agent, Context, Protocol
    from uagents_core.contrib.protocols.chat import (
        ChatAcknowledgement,
        ChatMessage,
        TextContent,
        chat_protocol_spec,
    )
    UAGENTS_AVAILABLE = True
except ImportError:
    UAGENTS_AVAILABLE = False


# ============================================================================
# Configuration (configured via environment variables or Agentverse Secrets)
# ============================================================================
ACCESSFIX_API_URL = os.getenv("ACCESSFIX_API_URL", "http://localhost:3000").rstrip("/")
ACCESSFIX_AGENT_TOKEN = os.getenv("ACCESSFIX_AGENT_TOKEN", "").strip()
AGENT_NAME = os.getenv("AGENT_NAME", "accessfix_agent")
AGENT_SEED = os.getenv("AGENT_SEED", "accessfix_agentverse_hosted_agent_seed_2026")
AGENT_PORT = int(os.getenv("AGENT_PORT", "8001"))

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("accessfix_agent")


# ============================================================================
# AccessFix API Client (uses `requests` with standard library fallback)
# ============================================================================
def call_accessfix_api(method: str, path: str, payload: dict = None) -> dict:
    """
    Executes an authenticated HTTP request against the AccessFix API.
    Uses `requests` when installed, falling back to `urllib.request`.
    """
    url = f"{ACCESSFIX_API_URL}{path}"
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    if ACCESSFIX_AGENT_TOKEN:
        headers["Authorization"] = f"Bearer {ACCESSFIX_AGENT_TOKEN}"

    if requests is not None:
        if method.upper() == "POST":
            resp = requests.post(url, json=payload, headers=headers, timeout=30)
        else:
            resp = requests.get(url, headers=headers, timeout=30)
        
        if resp.status_code >= 400:
            try:
                err_body = resp.json()
                msg = err_body.get("error") or resp.text
            except Exception:
                msg = resp.text
            raise RuntimeError(f"HTTP {resp.status_code}: {msg}")
        return resp.json()
    else:
        # Standard library urllib fallback
        data_bytes = json.dumps(payload).encode("utf-8") if payload else None
        req = urllib.request.Request(url, data=data_bytes, headers=headers, method=method.upper())
        try:
            with urllib.request.urlopen(req, timeout=30) as response:
                body = response.read().decode("utf-8")
                return json.loads(body)
        except urllib.error.HTTPError as http_err:
            body = http_err.read().decode("utf-8")
            try:
                err_body = json.loads(body)
                msg = err_body.get("error") or body
            except Exception:
                msg = body
            raise RuntimeError(f"HTTP {http_err.code}: {msg}")


def trigger_and_poll_run(
    target: str,
    use_cache: bool = True,
    timeout_sec: int = int(os.getenv("ACCESSFIX_TIMEOUT_SEC", "130")),
    poll_interval: int = 2
) -> dict:
    """
    Starts an accessibility repair run via POST /api/agent/runs and polls
    GET /api/agent/runs/:runId until completion or timeout.
    Reports real-time stage progress and captures exact failure stages and error messages.
    """
    mode_desc = "Cached Replay" if use_cache else "Live Execution"
    logger.info(f"Triggering AccessFix run for target='{target}' [{mode_desc}]...")
    init_data = call_accessfix_api("POST", "/api/agent/runs", {
        "url": target,
        "useCache": use_cache,
        "mode": "cached" if use_cache else "live",
    })

    run_id = init_data.get("runId")
    if not run_id:
        raise RuntimeError("No runId returned from AccessFix API.")

    logger.info(f"Run started with ID: {run_id}. Polling every {poll_interval}s for completion (timeout: {timeout_sec}s)...")
    start_time = time.time()
    last_stage = "init"
    last_run_data = {}

    while time.time() - start_time < timeout_sec:
        elapsed = int(time.time() - start_time)
        try:
            run_data = call_accessfix_api("GET", f"/api/agent/runs/{run_id}")
            last_run_data = run_data
        except Exception as poll_err:
            logger.warning(f"[{elapsed}s] Transient polling warning: {poll_err}")
            time.sleep(poll_interval)
            continue

        status = run_data.get("status", "running")
        stage = run_data.get("stage", last_stage)

        if stage != last_stage or elapsed % 6 == 0:
            logger.info(f"[{elapsed}s] Run {run_id}: status='{status}', active_stage='{stage}'")
            last_stage = stage

        if status == "completed":
            logger.info(f"✅ Run {run_id} completed successfully in {elapsed}s!")
            return run_data
        elif status == "failed":
            error_msg = run_data.get("error", "Unknown pipeline error")
            failed_stage = run_data.get("stage", last_stage)
            raise RuntimeError(f"AccessFix run {run_id} failed during stage '{failed_stage}': {error_msg}")

        time.sleep(poll_interval)

    # Attempt to read latest status from server to provide full failure diagnosis
    try:
        final_check = call_accessfix_api("GET", f"/api/agent/runs/{run_id}")
        last_run_data = final_check
    except Exception:
        pass

    final_status = last_run_data.get("status", "running")
    final_stage = last_run_data.get("stage", last_stage)
    final_error = last_run_data.get("error")

    raise RuntimeError(
        f"AccessFix run {run_id} timed out after {timeout_sec}s. "
        f"Last reported status: '{final_status}', stage: '{final_stage}'. "
        f"Server error: {final_error or 'Pipeline did not emit completion within deadline'}"
    )


# ============================================================================
# Response Formatter
# ============================================================================
def format_audit_summary(data: dict) -> str:
    """
    Formats the AccessFix audit result dictionary into a clean, professional
    markdown summary suitable for chat and conversational AI interfaces.
    Clearly distinguishes cached replay from live pipeline execution.
    """
    run_id = data.get("runId", "unknown")
    site_name = data.get("siteName", "unknown")
    target = data.get("target", site_name)
    metrics = data.get("metrics", {})
    agent_before = data.get("agentBefore") or {}
    agent_after = data.get("agentAfter") or {}
    fixes = data.get("fixesApplied", [])
    layout_flags = data.get("layoutFlags", [])
    needs_human = data.get("needsHuman", [])
    verification_status = data.get("verificationStatus", "passed").upper()

    # Determine execution mode label
    is_cached = data.get("isCached", data.get("useCache", True))
    mode_str = data.get("mode", "cached" if is_cached else "live")
    if mode_str == "auto_fallback":
        mode_label = "⚠️ AUTOMATIC FALLBACK REPLAY (Live execution failed; replayed cache)"
    elif is_cached or mode_str == "cached":
        mode_label = "📦 CACHED REPLAY (Recorded deterministic run from cache)"
    else:
        mode_label = "⚡ LIVE PIPELINE EXECUTION (Real-time Chromium, Axe scan, and autonomous Blind Agent)"

    status_icon = "✅ PASSED" if verification_status == "PASSED" else "⚠️ FAILED"
    axe_before = metrics.get("axeBefore", 0)
    axe_after = metrics.get("axeAfter", 0)

    # Agent before/after strings
    before_status = "PASSED" if agent_before.get("success") else "FAILED"
    before_steps = agent_before.get("steps", 0)
    before_stuck = agent_before.get("stuckAt")
    before_info = f"{before_status} ({before_steps} steps)"
    if before_stuck:
        before_info += f" — Barrier: {before_stuck}"

    after_status = "PASSED" if agent_after.get("success") else "FAILED"
    after_steps = agent_after.get("steps", 0)
    after_info = f"{after_status} ({after_steps} steps)"

    lines = [
        f"### 🛡️ AccessFix Closed-Loop Accessibility Audit",
        f"**Target:** `{target}`",
        f"**Execution Mode:** {mode_label}",
        f"**Verification Outcome:** {status_icon}",
        f"",
        f"#### 📊 Metrics & Verification",
        f"- **Axe WCAG Violations:** {axe_before} before ➔ **{axe_after} after** ({axe_before - axe_after} resolved)",
        f"- **Blind Agent (Initial):** {before_info}",
        f"- **Blind Agent (Verified):** {after_info}",
        f"- **Automated Code Fixes Applied:** {len(fixes)}",
    ]

    # Summarize fixes
    if fixes:
        lines.append(f"\n#### 🛠️ Repairs Synthesized & Applied")
        for i, fix in enumerate(fixes[:6], 1):
            op = fix.get("op", "edit")
            selector = fix.get("selector", "element")
            reason = fix.get("reason", "Semantic accessibility repair")
            lines.append(f"{i}. `[{op}]` `{selector}` — {reason}")
        if len(fixes) > 6:
            lines.append(f"... and {len(fixes) - 6} additional repairs.")
    else:
        lines.append(f"\n#### 🛠️ Repairs")
        lines.append("No code changes needed. Target page already meets accessibility criteria.")

    # Layout shift safeguards
    lines.append(f"\n#### 📐 Safeguards & Human Triage")
    if layout_flags:
        lines.append(f"- **Layout Flags:** {len(layout_flags)} element(s) shifted >5px (flagged for review)")
    else:
        lines.append("- **Layout Shifts:** None detected (all elements remained within 5 CSS pixels)")

    if needs_human:
        lines.append(f"- **Requires Human Review:** {len(needs_human)} ambiguous item(s) routed to triage queue")
    else:
        lines.append("- **Human Triage Queue:** 0 blocking ambiguities remaining")

    lines.append(f"\nUnified `.diff` patch and sandboxed preview available on server for Run ID: `{run_id}`")
    return "\n".join(lines)


def parse_user_request(text: str) -> tuple:
    """
    Extracts the target URL/fixture and cache mode from user chat input.
    """
    lower = text.lower()

    # Detect external URL
    url_match = re.search(r"https?://[^\s]+", text)
    if url_match:
        target = url_match.group(0).rstrip(".,;!?'\"")
        # Web URLs run live by default
        use_cache = "cache" in lower
        return target, use_cache

    # Detect fixed fixture
    if "fixed" in lower:
        use_cache = "live" not in lower
        return "demo-sites/fixed.html", use_cache

    # Default to broken demo fixture
    use_cache = "live" not in lower
    return "demo-sites/broken.html", use_cache


# ============================================================================
# Agentverse Agent Protocol Setup (Agent Chat Protocol - ACP)
# ============================================================================
if UAGENTS_AVAILABLE:
    chat_proto = Protocol(spec=chat_protocol_spec)

    @chat_proto.on_message(ChatMessage)
    async def handle_chat_message(ctx: Context, sender: str, msg: ChatMessage):
        ctx.logger.info(f"Received ChatMessage from {sender}: {msg}")

        # 1. Immediately send acknowledgement back per Agent Chat Protocol
        try:
            await ctx.send(
                sender,
                ChatAcknowledgement(
                    timestamp=datetime.now(timezone.utc),
                    msg_id=msg.msg_id,
                ),
            )
        except Exception:
            try:
                await ctx.send(
                    sender,
                    ChatAcknowledgement(timestamp=datetime.now(timezone.utc)),
                )
            except Exception as ack_err:
                ctx.logger.warning(f"Could not send ChatAcknowledgement: {ack_err}")

        # 2. Extract user prompt from content blocks
        user_prompt = ""
        for item in msg.content:
            if isinstance(item, TextContent):
                user_prompt += item.text + " "
            elif hasattr(item, "text"):
                user_prompt += str(getattr(item, "text", "")) + " "

        user_prompt = user_prompt.strip()
        ctx.logger.info(f"Extracted user prompt: '{user_prompt}'")

        target, use_cache = parse_user_request(user_prompt)

        # 3. Inform user that audit is running
        try:
            status_text = (
                f"Starting AccessFix accessibility audit for `{target}` "
                f"({'cached replay' if use_cache else 'live Chromium evaluation'})...\n"
                f"Simulating blind keyboard user traversal, computing Axe WCAG metrics, and synthesizing code repairs."
            )
            await ctx.send(
                sender,
                ChatMessage(
                    timestamp=datetime.now(timezone.utc),
                    msg_id=uuid4(),
                    content=[TextContent(type="text", text=status_text)],
                ),
            )
        except Exception as notify_err:
            ctx.logger.warning(f"Status notification send error: {notify_err}")

        # 4. Trigger and poll AccessFix run
        try:
            audit_result = trigger_and_poll_run(target, use_cache=use_cache)
            summary_markdown = format_audit_summary(audit_result)
        except Exception as run_err:
            ctx.logger.error(f"Audit failed: {run_err}")
            summary_markdown = (
                f"⚠️ **AccessFix Audit Failed**\n\n"
                f"- **Target:** `{target}`\n"
                f"- **Error:** {str(run_err)}\n\n"
                f"Please ensure the AccessFix server is running at `{ACCESSFIX_API_URL}` and `ACCESSFIX_AGENT_TOKEN` is configured."
            )

        # 5. Return complete audit report to user
        reply = ChatMessage(
            timestamp=datetime.now(timezone.utc),
            msg_id=uuid4(),
            content=[TextContent(type="text", text=summary_markdown)],
        )
        await ctx.send(sender, reply)

    @chat_proto.on_message(ChatAcknowledgement)
    async def handle_acknowledgement(ctx: Context, sender: str, msg: ChatAcknowledgement):
        ctx.logger.info(f"Received ChatAcknowledgement from {sender}")

    # Initialize the Agentverse Agent
    agent = Agent(
        name=AGENT_NAME,
        seed=AGENT_SEED,
        port=AGENT_PORT,
        endpoint=[f"http://localhost:{AGENT_PORT}/submit"],
    )
    agent.include(chat_proto, publish_manifest=True)


# ============================================================================
# CLI / Standalone Runner
# ============================================================================
def run_cli_test(target: str = "demo-sites/broken.html", use_cache: bool = True):
    """
    Executes a direct test against the AccessFix API and prints the summary.
    Allows end-to-end testing without deploying to Agentverse.
    """
    mode_title = "Cached Replay" if use_cache else "Live Execution"
    print("\n====================================================================")
    print(" AccessFix Agentverse Adapter — Standalone Test")
    print(f" Target API: {ACCESSFIX_API_URL}")
    print(f" Target URL: {target}")
    print(f" Mode:       {mode_title}")
    print(f" Auth Token: {'[Configured]' if ACCESSFIX_AGENT_TOKEN else '[Unset]'}")
    print("====================================================================\n")

    try:
        result = trigger_and_poll_run(target, use_cache=use_cache)
        print(format_audit_summary(result))
        print("\n====================================================================")
        print(f" Standalone test [{mode_title}] PASSED successfully!")
        print("====================================================================\n")
        return result
    except Exception as err:
        print(f"\n❌ Error during [{mode_title}] test: {err}\n", file=sys.stderr)
        raise


if __name__ == "__main__":
    # Convenience test flags
    if "--test-fixed" in sys.argv:
        try:
            run_cli_test("demo-sites/fixed.html", use_cache=True)
            sys.exit(0)
        except Exception:
            sys.exit(1)

    if "--test-live" in sys.argv:
        try:
            run_cli_test("demo-sites/broken.html", use_cache=False)
            sys.exit(0)
        except Exception:
            sys.exit(1)

    if "--test-all" in sys.argv:
        print("Running comprehensive test suite (Cached Fixed + Live Broken)...")
        try:
            print("\n[Suite 1/2] Testing demo-sites/fixed.html (Cached)...")
            run_cli_test("demo-sites/fixed.html", use_cache=True)
            print("\n[Suite 2/2] Testing demo-sites/broken.html (Live)...")
            run_cli_test("demo-sites/broken.html", use_cache=False)
            print("\n🎉 ALL TESTS IN SUITE PASSED SUCCESSFULLY!\n")
            sys.exit(0)
        except Exception:
            sys.exit(1)

    if "--test" in sys.argv or "--cli" in sys.argv or "--live" in sys.argv or "--cached" in sys.argv:
        custom_target = "demo-sites/broken.html"
        for arg in sys.argv[1:]:
            if not arg.startswith("--"):
                custom_target = arg
                break
        live_mode = "--live" in sys.argv
        if "--cached" in sys.argv:
            live_mode = False
        try:
            run_cli_test(custom_target, use_cache=not live_mode)
            sys.exit(0)
        except Exception:
            sys.exit(1)
    else:
        if not UAGENTS_AVAILABLE:
            print(
                "Notice: 'uagents' is not installed in the local environment.\n"
                "To run the live agent, install dependencies with: pip install -r requirements.txt\n"
                "Or run the standalone API test with: python3 agentverse/agent.py --test\n"
                "Or test cached fixed with: python3 agentverse/agent.py --test-fixed\n"
                "Or deploy this script directly into an Agentverse Hosted Agent."
            )
            sys.exit(0)
        logger.info(f"Starting AccessFix Agentverse Agent on port {AGENT_PORT}...")
        agent.run()
