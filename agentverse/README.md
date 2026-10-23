# AccessFix Agentverse Hosted Agent Adapter

This directory contains the Python adapter that connects **Fetch.ai Agentverse** and conversational frontends (such as **ASI:One**) to the **AccessFix** accessibility repair pipeline.

The adapter implements Fetch.ai's standardized **Agent Chat Protocol (ACP)** via `uagents_core.contrib.protocols.chat`.

---

## 🏗️ Architecture

```
┌─────────────────────────────────┐
│     User / ASI:One Chat UI      │
└────────────────┬────────────────┘
                 │ (Agent Chat Protocol - ACP)
                 ▼
┌─────────────────────────────────┐
│  Agentverse Hosted Agent        │
│  (agentverse/agent.py)          │
└────────────────┬────────────────┘
                 │ HTTP REST (Bearer Token Authentication)
                 │ POST /api/agent/runs  &  GET /api/agent/runs/:runId
                 ▼
┌─────────────────────────────────┐
│  AccessFix Server (Node/Express)│
│  - SSRF & File Protection       │
│  - Closed-Loop Repair Pipeline  │
└─────────────────────────────────┘
```

---

## 🚀 Deployment to Agentverse (Hosted Agent)

Deploying to Agentverse Hosted Agents requires zero local infrastructure for the agent runtime:

### Step 1: Create Hosted Agent
1. Sign in to [Agentverse](https://agentverse.ai/).
2. Navigate to **My Agents** and click **+ New Agent**.
3. Select **Hosted Agent** (or Blank Agent).

### Step 2: Paste Adapter Code
1. Open the agent editor in Agentverse.
2. Replace the editor contents with the code from `agentverse/agent.py`.

### Step 3: Configure Agent Secrets
In the Agentverse left sidebar, click **Secrets** and add the following keys:
- `ACCESSFIX_API_URL`: The public URL where your AccessFix Node.js server is hosted (e.g. `https://your-accessfix-domain.com` or an ngrok/cloud tunnel URL).
- `ACCESSFIX_AGENT_TOKEN`: The secure authorization token configured in your AccessFix server's `.env` (`ACCESSFIX_AGENT_TOKEN`).

### Step 4: Run the Agent
Click **Start** or **Run**. Agentverse will compile the protocol manifest and register the agent on the Almanac.

### Step 5: Test via Chat
Open the chat window in Agentverse or connect via ASI:One, then send requests such as:
- *"Audit broken.html"*
- *"Run accessibility check on demo-sites/fixed.html"*
- *"Scan https://example.com"*
- *"Run live audit on broken"*

The agent will acknowledge receipt immediately, trigger the AccessFix pipeline, poll for completion, and return a comprehensive audit report.

---

## 🧪 Local Testing

You can also run or test the adapter locally:

### Option A: Standalone CLI Test (Direct API verification)
You can test the adapter's connection to your AccessFix server directly from the command line:

```bash
# Test the default broken fixture (replays cached run)
python3 agentverse/agent.py --test

# Test the fixed fixture
python3 agentverse/agent.py --test demo-sites/fixed.html

# Test in live mode (launches Chromium pipeline)
python3 agentverse/agent.py --test demo-sites/broken.html --live
```

### Option B: Run Local uAgents Process
To run as a full local uAgents process listening on port 8001:

```bash
cd agentverse
pip install -r requirements.txt
cp .env.example .env
# Edit .env to set ACCESSFIX_API_URL and ACCESSFIX_AGENT_TOKEN
python3 agent.py
```

---

## 🔒 Security & Authentication

- **Bearer Token Enforcement**: All requests from the adapter to `/api/agent/runs` require a Bearer token matching `ACCESSFIX_AGENT_TOKEN`.
- **SSRF Prevention**: The AccessFix API strictly blocks attempts to access private subnets (`10.0.0.0/8`, `192.168.0.0/16`, `172.16.0.0/12`), loopback (`127.0.0.1`, `localhost`), and cloud metadata (`169.254.169.254`, `metadata.google.internal`).
- **Arbitrary File Prevention**: Local file inputs are strictly restricted to predefined demo fixtures (`demo-sites/broken.html` and `demo-sites/fixed.html`). Arbitrary paths like `/etc/passwd` or `.env` are rejected.

---

## 📋 Protocol Specifications

The adapter adheres strictly to the official Fetch.ai Agent Chat Protocol:
- **Specification**: `chat_protocol_spec` from `uagents_core.contrib.protocols.chat`
- **Inbound Message**: `ChatMessage` containing structured `content` (`TextContent`)
- **Receipt Confirmation**: `ChatAcknowledgement` returning `msg_id` and timestamp
- **Outbound Report**: `ChatMessage` wrapping formatted Markdown `TextContent`
