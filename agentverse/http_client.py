"""
AccessFix HTTP Client
=====================
Client module for Fetch.ai Agentverse / ASI:One Hosted Agents.
Triggers accessibility repair runs on AccessFix and waits for genuine terminal
results using Server-Sent Events (GET /events) with reliable JSON polling fallback.
"""

import os
import sys
import time
import json
import logging
from typing import Optional, Dict, Any, Callable

# Load environment variables if available
try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

# Manual .env fallback if environment variables are not set
if not os.getenv("ACCESSFIX_API_URL") or not os.getenv("ACCESSFIX_AGENT_TOKEN"):
    for env_path in [
        os.path.join(os.path.dirname(__file__), "..", ".env"),
        os.path.join(os.getcwd(), ".env"),
    ]:
        if os.path.exists(env_path):
            try:
                with open(env_path, "r", encoding="utf-8") as f:
                    for line in f:
                        line = line.strip()
                        if line and not line.startswith("#") and "=" in line:
                            k, v = line.split("=", 1)
                            k, v = k.strip(), v.strip().strip("'\"")
                            if k and not os.getenv(k):
                                os.environ[k] = v
                break
            except Exception:
                pass

try:
    import requests
except ImportError:
    requests = None
    import urllib.request
    import urllib.error

logger = logging.getLogger("accessfix_http_client")


class AccessFixClient:
    """
    HTTP client for the AccessFix backend service.
    Implements run dispatch, SSE event consumption, status polling, and error recovery.
    """

    def __init__(self, base_url: Optional[str] = None, token: Optional[str] = None):
        raw_url = base_url or os.getenv("ACCESSFIX_API_URL", "http://localhost:3000")
        self.base_url = raw_url.rstrip("/")
        self.token = (token or os.getenv("ACCESSFIX_AGENT_TOKEN", "")).strip()

    def _get_headers(self, accept: str = "application/json") -> Dict[str, str]:
        headers = {
            "Content-Type": "application/json",
            "Accept": accept,
        }
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        return headers

    def start_run(self, target: str, use_cache: bool = True, mode: Optional[str] = None) -> Dict[str, Any]:
        """
        Initiates an accessibility run via POST /run.
        Returns the initial run descriptor containing runId and status: 'started'.
        NEVER interprets this initial 200 response as completion.
        """
        endpoint = f"{self.base_url}/run"
        payload = {
            "url": target,
            "useCache": use_cache,
            "mode": mode or ("cached" if use_cache else "live"),
        }
        headers = self._get_headers()

        logger.info(f"Dispatching POST {endpoint} (target='{target}', useCache={use_cache}, mode={payload['mode']})...")

        if requests is not None:
            resp = requests.post(endpoint, json=payload, headers=headers, timeout=30)
            if resp.status_code >= 400:
                try:
                    err = resp.json().get("error") or resp.text
                except Exception:
                    err = resp.text
                raise RuntimeError(f"Failed to start AccessFix run (HTTP {resp.status_code}): {err}")
            data = resp.json()
        else:
            data_bytes = json.dumps(payload).encode("utf-8")
            req = urllib.request.Request(endpoint, data=data_bytes, headers=headers, method="POST")
            try:
                with urllib.request.urlopen(req, timeout=30) as r:
                    data = json.loads(r.read().decode("utf-8"))
            except urllib.error.HTTPError as http_err:
                body = http_err.read().decode("utf-8")
                try:
                    err = json.loads(body).get("error") or body
                except Exception:
                    err = body
                raise RuntimeError(f"Failed to start AccessFix run (HTTP {http_err.code}): {err}")

        run_id = data.get("runId")
        if not run_id:
            raise RuntimeError(f"Invalid server response: missing 'runId' in {data}")

        initial_status = data.get("status", "started")
        logger.info(f"Run dispatched successfully: runId='{run_id}', initial_status='{initial_status}'. Waiting for execution...")
        return data

    def wait_for_completion_sse(
        self,
        run_id: str,
        timeout_sec: int = 120,
        on_progress: Optional[Callable[[str, str, Dict[str, Any]], None]] = None,
    ) -> Optional[Dict[str, Any]]:
        """
        Listens to Server-Sent Events on GET /events?runId=:runId.
        Parses stream events ('stage', 'complete', 'error').
        Returns the terminal result dictionary upon 'complete', or None if SSE stream drops.
        """
        if requests is None:
            logger.debug("`requests` not available; skipping SSE stream and using JSON status polling.")
            return None

        sse_url = f"{self.base_url}/events?runId={run_id}"
        headers = self._get_headers(accept="text/event-stream")
        start_time = time.time()

        logger.info(f"Connecting to SSE stream: {sse_url} (timeout: {timeout_sec}s)...")
        try:
            with requests.get(sse_url, headers=headers, stream=True, timeout=timeout_sec) as response:
                if response.status_code != 200:
                    logger.warning(f"SSE endpoint returned HTTP {response.status_code}; falling back to polling.")
                    return None

                current_event = None
                current_data_lines = []

                for raw_line in response.iter_lines(decode_unicode=True):
                    if time.time() - start_time > timeout_sec:
                        raise TimeoutError(f"AccessFix run {run_id} timed out after {timeout_sec}s while listening to SSE.")

                    if raw_line is None:
                        continue

                    line = raw_line.strip()

                    # Blank line signals end of an SSE message block
                    if not line:
                        if current_event and current_data_lines:
                            data_str = "\n".join(current_data_lines)
                            try:
                                payload = json.loads(data_str)
                            except Exception:
                                payload = {"raw": data_str}

                            result = self._handle_sse_event(run_id, current_event, payload, on_progress)
                            if result is not None:
                                return result

                        current_event = None
                        current_data_lines = []
                        continue

                    if line.startswith("event:"):
                        current_event = line[len("event:"):].strip()
                    elif line.startswith("data:"):
                        current_data_lines.append(line[len("data:"):].strip())

        except (requests.exceptions.RequestException, TimeoutError) as e:
            if isinstance(e, TimeoutError):
                raise
            logger.warning(f"SSE stream ended or interrupted ({e}); resuming with JSON status polling.")
            return None

        return None

    def _handle_sse_event(
        self,
        run_id: str,
        event_name: str,
        payload: Dict[str, Any],
        on_progress: Optional[Callable[[str, str, Dict[str, Any]], None]] = None,
    ) -> Optional[Dict[str, Any]]:
        """
        Handles a single parsed SSE message block.
        """
        if event_name == "stage":
            stage = payload.get("stage", "working")
            status = payload.get("status", "running")
            message = payload.get("message", "")
            data = payload.get("data", {})
            logger.info(f"[SSE Stage] runId={run_id} | stage='{stage}' ({status}) — {message}")
            if on_progress:
                try:
                    on_progress(stage, message, data)
                except Exception:
                    pass
            return None

        if event_name == "complete":
            logger.info(f"✅ [SSE Complete] Received terminal complete event for runId={run_id}!")
            return self._normalize_from_event(run_id, payload)

        if event_name == "error":
            error_msg = payload.get("message") or payload.get("error") or "Pipeline execution error"
            logger.error(f"❌ [SSE Error] Run {run_id} failed: {error_msg}")
            raise RuntimeError(f"AccessFix run {run_id} failed: {error_msg}")

        return None

    def wait_for_completion_polling(
        self,
        run_id: str,
        timeout_sec: int = 120,
        poll_interval: float = 2.0,
        on_progress: Optional[Callable[[str, str, Dict[str, Any]], None]] = None,
    ) -> Dict[str, Any]:
        """
        Polls GET /run/:runId (with fallback to GET /api/agent/runs/:runId)
        until status reaches terminal state ('completed' or 'failed') or times out.
        """
        endpoint = f"{self.base_url}/run/{run_id}"
        alt_endpoint = f"{self.base_url}/api/agent/runs/{run_id}"
        headers = self._get_headers()
        start_time = time.time()
        last_stage = "init"
        last_data = {}

        logger.info(f"Polling status on {endpoint} (timeout: {timeout_sec}s, interval: {poll_interval}s)...")

        while time.time() - start_time < timeout_sec:
            elapsed = int(time.time() - start_time)
            run_data = None

            # Try primary /run/:runId
            try:
                if requests is not None:
                    resp = requests.get(endpoint, headers=headers, timeout=15)
                    if resp.status_code == 200:
                        run_data = resp.json()
                else:
                    req = urllib.request.Request(endpoint, headers=headers, method="GET")
                    with urllib.request.urlopen(req, timeout=15) as r:
                        run_data = json.loads(r.read().decode("utf-8"))
            except Exception:
                pass

            # Fallback to /api/agent/runs/:runId if primary is 404 or failed
            if not run_data:
                try:
                    if requests is not None:
                        resp = requests.get(alt_endpoint, headers=headers, timeout=15)
                        if resp.status_code == 200:
                            run_data = resp.json()
                    else:
                        req = urllib.request.Request(alt_endpoint, headers=headers, method="GET")
                        with urllib.request.urlopen(req, timeout=15) as r:
                            run_data = json.loads(r.read().decode("utf-8"))
                except Exception:
                    pass

            if run_data:
                last_data = run_data
                status = run_data.get("status", "running")
                stage = run_data.get("stage", last_stage)

                if stage != last_stage or elapsed % 6 == 0:
                    logger.info(f"[{elapsed}s] Run {run_id}: status='{status}', stage='{stage}'")
                    last_stage = stage
                    if on_progress:
                        try:
                            on_progress(stage, f"Pipeline in stage: {stage}", run_data)
                        except Exception:
                            pass

                if status == "completed":
                    logger.info(f"✅ Run {run_id} completed successfully in {elapsed}s!")
                    return self._normalize_from_polling(run_id, run_data)
                elif status == "failed":
                    err = run_data.get("error") or "Pipeline execution failed"
                    failed_stage = run_data.get("stage", last_stage)
                    raise RuntimeError(f"AccessFix run {run_id} failed during stage '{failed_stage}': {err}")

            time.sleep(poll_interval)

        final_stage = last_data.get("stage", last_stage)
        final_error = last_data.get("error") or "Pipeline did not reach terminal completion within deadline"
        raise TimeoutError(f"AccessFix run {run_id} timed out after {timeout_sec}s. Last stage: '{final_stage}'. Error: {final_error}")

    def wait_for_run(
        self,
        run_id: str,
        timeout_sec: int = 120,
        on_progress: Optional[Callable[[str, str, Dict[str, Any]], None]] = None,
    ) -> Dict[str, Any]:
        """
        Coordinates waiting for terminal results.
        Attempts SSE stream connection first; falls back to polling if SSE is disconnected.
        """
        start_time = time.time()
        sse_result = self.wait_for_completion_sse(run_id, timeout_sec=timeout_sec, on_progress=on_progress)
        if sse_result is not None:
            return sse_result

        remaining_time = max(5, int(timeout_sec - (time.time() - start_time)))
        return self.wait_for_completion_polling(run_id, timeout_sec=remaining_time, on_progress=on_progress)

    def run_audit(
        self,
        target: str,
        use_cache: bool = True,
        timeout_sec: int = 120,
        on_progress: Optional[Callable[[str, str, Dict[str, Any]], None]] = None,
    ) -> Dict[str, Any]:
        """
        Complete end-to-end execution:
        1. Dispatches run via POST /run
        2. Extracts runId (ensuring 'started' is not treated as finished)
        3. Waits for real terminal results via SSE or polling
        4. Returns verified audit result dictionary
        """
        init_data = self.start_run(target, use_cache=use_cache)
        run_id = init_data["runId"]
        return self.wait_for_run(run_id, timeout_sec=timeout_sec, on_progress=on_progress)

    def _normalize_from_event(self, run_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        result = payload.get("result", {})
        data = payload.get("data", {})

        agent_before = result.get("agentBefore") or data.get("agentBefore") or {}
        agent_after = result.get("agentAfter") or data.get("agentAfter") or {}
        applied_ops = data.get("ops") or []
        layout_flags = data.get("layoutFlags") or []
        needs_human = data.get("needsHuman") or []

        axe_before = result.get("axeBefore", data.get("axeBefore", 0))
        axe_after = result.get("axeAfter", data.get("axeAfter", 0))
        fixes_count = result.get("fixesCount", len(applied_ops))
        layout_flags_count = result.get("layoutFlagsCount", len(layout_flags))
        needs_human_count = result.get("needsHumanCount", len(needs_human))

        is_passed = bool(agent_after.get("success", False)) and axe_after == 0

        return {
            "runId": run_id,
            "status": "completed",
            "stage": "complete",
            "verificationStatus": "passed" if is_passed else "failed",
            "metrics": {
                "axeBefore": axe_before,
                "axeAfter": axe_after,
                "fixesCount": fixes_count,
                "layoutFlagsCount": layout_flags_count,
                "needsHumanCount": needs_human_count,
            },
            "agentBefore": agent_before,
            "agentAfter": agent_after,
            "fixesApplied": applied_ops,
            "layoutFlags": layout_flags,
            "needsHuman": needs_human,
            "diff": data.get("diff", ""),
        }

    def _normalize_from_polling(self, run_id: str, run_data: Dict[str, Any]) -> Dict[str, Any]:
        metrics = run_data.get("metrics", {})
        agent_before = run_data.get("agentBefore") or {}
        agent_after = run_data.get("agentAfter") or {}
        applied_ops = run_data.get("fixesApplied") or []
        layout_flags = run_data.get("layoutFlags") or []
        needs_human = run_data.get("needsHuman") or []

        axe_before = metrics.get("axeBefore", 0)
        axe_after = metrics.get("axeAfter", 0)
        is_passed = bool(agent_after.get("success", False)) and axe_after == 0

        return {
            "runId": run_id,
            "status": "completed",
            "stage": "complete",
            "mode": run_data.get("mode", "live"),
            "isLive": run_data.get("isLive", True),
            "isCached": run_data.get("isCached", False),
            "target": run_data.get("target", ""),
            "siteName": run_data.get("siteName", ""),
            "verificationStatus": run_data.get("verificationStatus") or ("passed" if is_passed else "failed"),
            "metrics": {
                "axeBefore": axe_before,
                "axeAfter": axe_after,
                "fixesCount": metrics.get("fixesCount", len(applied_ops)),
                "layoutFlagsCount": metrics.get("layoutFlagsCount", len(layout_flags)),
                "needsHumanCount": metrics.get("needsHumanCount", len(needs_human)),
            },
            "agentBefore": agent_before,
            "agentAfter": agent_after,
            "fixesApplied": applied_ops,
            "layoutFlags": layout_flags,
            "needsHuman": needs_human,
            "diff": run_data.get("diff", ""),
        }


# ============================================================================
# CLI Standalone Testing
# ============================================================================
if __name__ == "__main__":
    target_arg = "demo-sites/broken.html"
    live_mode = False

    for arg in sys.argv[1:]:
        if arg == "--live":
            live_mode = True
        elif arg == "--cached":
            live_mode = False
        elif not arg.startswith("--"):
            target_arg = arg

    client = AccessFixClient()
    print("\n====================================================================")
    print(" AccessFix HTTP Client — Standalone Verification Runner")
    print(f" Target API: {client.base_url}")
    print(f" Target:     {target_arg}")
    print(f" Mode:       {'Live Execution' if live_mode else 'Cached Replay'}")
    print("====================================================================\n")

    try:
        final_result = client.run_audit(target_arg, use_cache=not live_mode, timeout_sec=120)
        print("\n====================================================================")
        print(" Audit Run Terminal Result Successfully Received!")
        print("====================================================================")
        print(f"Run ID:              {final_result['runId']}")
        print(f"Status:              {final_result['status']}")
        print(f"Verification:        {final_result['verificationStatus'].upper()}")
        print(f"Axe Violations:      {final_result['metrics']['axeBefore']} -> {final_result['metrics']['axeAfter']}")
        print(f"Blind Agent Before:  {final_result['agentBefore'].get('success')} ({final_result['agentBefore'].get('steps')} steps)")
        print(f"Blind Agent After:   {final_result['agentAfter'].get('success')} ({final_result['agentAfter'].get('steps')} steps)")
        print(f"Fixes Applied:       {len(final_result['fixesApplied'])}")
        print(f"Layout Flags:        {len(final_result['layoutFlags'])}")
        print(f"Human Triage Items:  {len(final_result['needsHuman'])}")
        print("====================================================================\n")
        sys.exit(0)
    except Exception as err:
        print(f"\n❌ Error during audit run: {err}\n", file=sys.stderr)
        sys.exit(1)
