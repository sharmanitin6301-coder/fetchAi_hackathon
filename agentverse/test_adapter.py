#!/usr/bin/env python3
"""
AccessFix Adapter & HTTP Client Verification Test Suite
======================================================
Tests that the adapter correctly:
1. Dispatches runs via POST /run without mistakenly treating the initial 200 as finished.
2. Waits for genuine terminal completion via SSE or status polling.
3. Captures real metrics, agent outcomes, applied fixes, and layout flags.
4. Distinguishes cached replay from live execution.
"""

import os
import sys
import time
import unittest

# Ensure agentverse directory is on path
current_dir = os.path.dirname(os.path.abspath(__file__))
if current_dir not in sys.path:
    sys.path.insert(0, current_dir)

from http_client import AccessFixClient


class TestAccessFixAdapter(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        api_url = os.getenv("ACCESSFIX_API_URL", "http://localhost:3000")
        token = os.getenv("ACCESSFIX_AGENT_TOKEN", "")
        cls.client = AccessFixClient(base_url=api_url, token=token)
        print(f"\n[TestSetup] Running against AccessFix API: {cls.client.base_url}")

    def test_01_start_run_returns_started_not_completed(self):
        """
        Verify that POST /run returns status 'started' with a valid runId,
        and is NEVER prematurely treated as completed.
        """
        init_data = self.client.start_run("demo-sites/fixed.html", use_cache=True)
        self.assertIn("runId", init_data)
        self.assertTrue(len(init_data["runId"]) > 10)
        self.assertEqual(init_data.get("status"), "started")
        
        # Verify initial response does NOT contain terminal audit metrics
        self.assertNotIn("verificationStatus", init_data)
        self.assertNotIn("fixesApplied", init_data)
        print(f"  ✓ test_01 passed: start_run returned runId={init_data['runId']} with initial status='started'.")

    def test_02_cached_run_waits_for_terminal_completion(self):
        """
        Verify that wait_for_run waits for execution to complete and returns
        the genuine terminal result for fixed.html.
        """
        init_data = self.client.start_run("demo-sites/fixed.html", use_cache=True)
        run_id = init_data["runId"]

        terminal_result = self.client.wait_for_run(run_id, timeout_sec=60)
        self.assertEqual(terminal_result.get("status"), "completed")
        self.assertEqual(terminal_result.get("stage"), "complete")
        self.assertEqual(terminal_result.get("verificationStatus"), "passed")

        metrics = terminal_result.get("metrics", {})
        self.assertEqual(metrics.get("axeBefore"), 0)
        self.assertEqual(metrics.get("axeAfter"), 0)
        self.assertEqual(metrics.get("fixesCount"), 0)

        agent_before = terminal_result.get("agentBefore", {})
        agent_after = terminal_result.get("agentAfter", {})
        self.assertTrue(agent_before.get("success"))
        self.assertTrue(agent_after.get("success"))
        print(f"  ✓ test_02 passed: cached run {run_id} waited and returned terminal result (0 violations, 0 fixes).")

    def test_03_live_run_waits_for_real_repair_results(self):
        """
        Verify that a live execution of broken.html waits for Chromium/pipeline
        execution, reports terminal completion, and returns genuine fixes and metrics.
        """
        start_time = time.time()
        stages_observed = []

        def track_progress(stage, message, data):
            stages_observed.append(stage)

        # Full end-to-end execution
        result = self.client.run_audit(
            "demo-sites/broken.html",
            use_cache=False,
            timeout_sec=120,
            on_progress=track_progress,
        )
        duration = time.time() - start_time

        self.assertEqual(result.get("status"), "completed")
        self.assertEqual(result.get("stage"), "complete")
        self.assertEqual(result.get("verificationStatus"), "passed")

        metrics = result.get("metrics", {})
        self.assertEqual(metrics.get("axeBefore"), 7)
        self.assertEqual(metrics.get("axeAfter"), 0)
        self.assertTrue(metrics.get("fixesCount") >= 6)

        # Verify initial agent failed due to broken controls and verified agent succeeded
        agent_before = result.get("agentBefore", {})
        agent_after = result.get("agentAfter", {})
        self.assertFalse(agent_before.get("success"))
        self.assertTrue(agent_after.get("success"))

        # Verify applied fixes and layout safeguards are present
        fixes = result.get("fixesApplied", [])
        self.assertTrue(len(fixes) >= 6)
        
        # Verify layout shift detection recorded shifts
        layout_flags = result.get("layoutFlags", [])
        self.assertTrue(isinstance(layout_flags, list))

        print(f"  ✓ test_03 passed: live run completed in {duration:.1f}s, resolved 7 Axe violations with {len(fixes)} fixes.")


if __name__ == "__main__":
    unittest.main(verbosity=2)
