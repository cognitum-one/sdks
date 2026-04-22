# Claude Code Configuration - Claude Flow V3

## 📋 Project Management (cognitum-one GitHub Projects)

**Internal PM system:** https://github.com/orgs/cognitum-one/projects (7 projects)

| # | Project | Scope |
|---|---------|-------|
| 1 | Product Roadmap | Epics, ADRs, migrations, long-horizon planning |
| 2 | Engineering Sprint | Active 2-week dev work, kanban, L10-aligned |
| 3 | Seed Fleet & Firmware | Pi Zero firmware, OTA, gold images, fleet ops |
| 4 | Cog Store | 90+ Rust cogs, build/test/publish pipeline |
| 5 | Manage Dashboard | manage.cognitum.one features/bugs |
| 6 | Security & Compliance | CVEs, audits, ADR reviews |
| 7 | Bugs & Incidents | Triage queue, SLA-driven, incident response |

**Shared custom fields on every project:** `Priority` (P0-P3), `Component` (seed/hub/mesh/cogs/dashboard/manage-ui/api/infra/docs), `Effort` (XS-XL), `Due Date`, `Sprint`, plus GitHub defaults (Status, Assignees, Labels, Milestone, Repository).

### When creating issues/PRs

**Always** add the issue/PR to the right project in the SAME step:

```bash
# Create issue
URL=$(gh issue create --repo <owner>/<repo> --title "..." --body "..." --label "<label>" | tail -1)

# Add to project (primary category)
gh project item-add <project-num> --owner cognitum-one --url "$URL"

# Cross-link if it's a bug (also add to Bugs project #7)
gh project item-add 7 --owner cognitum-one --url "$URL"
```

### Routing issues to projects (decision tree)

1. **Is it a bug or incident?** → Project #7 (+ also the owning domain project)
2. **Is it a security/CVE/audit item?** → Project #6
3. **Does it target seed firmware / fleet / OTA / gold image?** → Project #3
4. **Is it cog-specific (in `src/cogs/`, 90+ Rust apps)?** → Project #4
5. **Is it manage.cognitum.one UI/backend?** → Project #5
6. **Is it a Windows/macOS optimizer feature or ADR implementation?** → Project #1 (Roadmap)
7. **Is it a current sprint task with owner + due date?** → Project #2 (Engineering Sprint)
8. **Otherwise:** Project #1 (Roadmap) as default

### Source repos (current)

- `ruvnet/optimizer` — current monolith; being split (tracked by #71-#79)
- `ruvnet/cognitum` — dashboard + management-ui

### Cognitum platform (meta + 8 products, all private)

**Meta-repo:** [`cognitum-one/cognitum`](https://github.com/cognitum-one/cognitum) — umbrella with all 8 product repos as submodules under `repos/`.

```bash
# Clone everything
git clone --recursive https://github.com/cognitum-one/cognitum.git

# Pull latest from all submodules + commit version bump
cd cognitum
./scripts/update-all.sh --commit

# See pinned SHA per submodule
./scripts/status-all.sh
```

| Product repo | Status | Populated from |
|---|---|---|
| [`seed`](https://github.com/cognitum-one/seed) | ✅ migrated + v0.10.11.5 released | optimizer filter-repo |
| [`v0-appliance`](https://github.com/cognitum-one/v0-appliance) | ⏳ stub, ticket #73 | optimizer/docker/cognitum-v0, scripts/pi5 |
| [`cogs`](https://github.com/cognitum-one/cogs) | ⏳ stub, ticket #74 | optimizer/src/cogs, src/apps |
| [`mesh`](https://github.com/cognitum-one/mesh) | ⏳ stub, ticket #75 | optimizer/src/cloud-services, cloud-functions |
| [`management`](https://github.com/cognitum-one/management) | ⏳ stub, ticket #76 | ruvnet/cognitum + optimizer/src/dashboard |
| [`windows-optimizer`](https://github.com/cognitum-one/windows-optimizer) | ⏳ stub, ticket #77 | optimizer/src/{core,features,bin}, store/ |
| [`macos-optimizer`](https://github.com/cognitum-one/macos-optimizer) | ⏳ stub, ticket #78 | optimizer/src/macos |
| [`platform-docs`](https://github.com/cognitum-one/platform-docs) | ⏳ stub, ticket #79 | optimizer/docs/adr, patents |

### Submodule update workflow

**Bumping a submodule after pushing changes to its product repo:**

```bash
# In the meta-repo
cd repos/<product>
git pull origin main
cd ../..
git add repos/<product>
git commit -m "bump: <product> → $(cd repos/<product> && git log -1 --format=%h)"
git push
```

**Pin to a release tag (for coordinated releases):**

```bash
cd repos/seed
git checkout v0.10.11.5
cd ../..
git add repos/seed
git commit -m "pin: seed → v0.10.11.5"
```

**Rules:**
- NEVER edit files inside `repos/<product>/` from the meta-repo without first entering that submodule dir
- Always push submodule changes to their product repo BEFORE bumping the meta-repo pointer
- Meta-repo commits should only contain submodule SHA bumps + meta-level config (CI, README) — no product code
- For shared Rust crates (cog-sdk, mesh-proto, future), extract to own repos and add as submodules in consumers

### GitHub Projects CLI cheatsheet

```bash
# List projects
gh project list --owner cognitum-one

# Add item
gh project item-add <num> --owner cognitum-one --url <issue-or-pr-url>

# Set custom field value (use field-list to get field IDs first)
gh project field-list <num> --owner cognitum-one --format json
gh project item-edit --id <item-id> --project-id <proj-id> --field-id <field-id> --single-select-option-id <opt-id>

# View items
gh project item-list <num> --owner cognitum-one --limit 100
```

### Rules

- NEVER create a GitHub issue without also adding it to at least one project
- NEVER create a PR for cognitum work without linking to its parent issue
- When in doubt on routing, default to Project #1 (Roadmap) — easier to move later than to lose track
- Bugs ALWAYS get cross-linked to Project #7
- Migration work (#71-#79) is all tracked in Project #1

---

## 🚨 AUTOMATIC SWARM ORCHESTRATION

**When starting work on complex tasks, Claude Code MUST automatically:**

1. **Initialize the swarm** using CLI tools via Bash
2. **Spawn concurrent agents** using Claude Code's Task tool
3. **Coordinate via hooks** and memory

### 🚨 CRITICAL: CLI + Task Tool in SAME Message

**When user says "spawn swarm" or requests complex work, Claude Code MUST in ONE message:**
1. Call CLI tools via Bash to initialize coordination
2. **IMMEDIATELY** call Task tool to spawn REAL working agents
3. Both CLI and Task calls must be in the SAME response

**CLI coordinates, Task tool agents do the actual work!**

### 🤖 INTELLIGENT 3-TIER MODEL ROUTING (ADR-026)

**The routing system has 3 tiers for optimal cost/performance:**

| Tier | Handler | Latency | Cost | Use Cases |
|------|---------|---------|------|-----------|
| **1** | Agent Booster | <1ms | $0 | Simple transforms (var→const, add-types, remove-console) |
| **2** | Haiku | ~500ms | $0.0002 | Simple tasks, bug fixes, low complexity |
| **3** | Sonnet/Opus | 2-5s | $0.003-$0.015 | Architecture, security, complex reasoning |

**Before spawning agents, get routing recommendation:**
```bash
npx @claude-flow/cli@latest hooks pre-task --description "[task description]"
```

**When you see these recommendations:**

1. `[AGENT_BOOSTER_AVAILABLE]` → Skip LLM entirely, use Edit tool directly
   - Intent types: `var-to-const`, `add-types`, `add-error-handling`, `async-await`, `add-logging`, `remove-console`

2. `[TASK_MODEL_RECOMMENDATION] Use model="X"` → Use that model in Task tool:
```javascript
Task({
  prompt: "...",
  subagent_type: "coder",
  model: "haiku"  // ← USE THE RECOMMENDED MODEL (haiku/sonnet/opus)
})
```

**Benefits:** 75% cost reduction, 352x faster for Tier 1 tasks

---

### 🛡️ Anti-Drift Config (PREFERRED)

**Use this to prevent agent drift:**
```bash
# Small teams (6-8 agents) - use hierarchical for tight control
npx @claude-flow/cli@latest swarm init --topology hierarchical --max-agents 8 --strategy specialized

# Large teams (10-15 agents) - use hierarchical-mesh for V3 queen + peer communication
npx @claude-flow/cli@latest swarm init --topology hierarchical-mesh --max-agents 15 --strategy specialized
```

**Valid Topologies:**
- `hierarchical` - Queen controls workers directly (anti-drift for small teams)
- `hierarchical-mesh` - V3 queen + peer communication (recommended for 10+ agents)
- `mesh` - Fully connected peer network
- `ring` - Circular communication pattern
- `star` - Central coordinator with spokes
- `hybrid` - Dynamic topology switching

**Anti-Drift Guidelines:**
- **hierarchical**: Coordinator catches divergence
- **max-agents 6-8**: Smaller team = less drift
- **specialized**: Clear roles, no overlap
- **consensus**: raft (leader maintains state)

---

### 🔄 Auto-Start Swarm Protocol (Background Execution)

When the user requests a complex task, **spawn agents in background and WAIT for completion:**

```javascript
// STEP 1: Initialize swarm coordination (anti-drift config)
Bash("npx @claude-flow/cli@latest swarm init --topology hierarchical --max-agents 8 --strategy specialized")

// STEP 2: Spawn ALL agents IN BACKGROUND in a SINGLE message
// Use run_in_background: true so agents work concurrently
Task({
  prompt: "Research requirements, analyze codebase patterns, store findings in memory",
  subagent_type: "researcher",
  description: "Research phase",
  run_in_background: true  // ← CRITICAL: Run in background
})
Task({
  prompt: "Design architecture based on research. Document decisions.",
  subagent_type: "system-architect",
  description: "Architecture phase",
  run_in_background: true
})
Task({
  prompt: "Implement the solution following the design. Write clean code.",
  subagent_type: "coder",
  description: "Implementation phase",
  run_in_background: true
})
Task({
  prompt: "Write comprehensive tests for the implementation.",
  subagent_type: "tester",
  description: "Testing phase",
  run_in_background: true
})
Task({
  prompt: "Review code quality, security, and best practices.",
  subagent_type: "reviewer",
  description: "Review phase",
  run_in_background: true
})

// STEP 3: WAIT - Tell user agents are working, then STOP
// Say: "I've spawned 5 agents to work on this in parallel. They'll report back when done."
// DO NOT check status repeatedly. Just wait for user or agent responses.
```

### ⏸️ CRITICAL: Spawn and Wait Pattern

**After spawning background agents:**

1. **TELL USER** - "I've spawned X agents working in parallel on: [list tasks]"
2. **STOP** - Do not continue with more tool calls
3. **WAIT** - Let the background agents complete their work
4. **RESPOND** - When agents return results, review and synthesize

**Example response after spawning:**
```
I've launched 5 concurrent agents to work on this:
- 🔍 Researcher: Analyzing requirements and codebase
- 🏗️ Architect: Designing the implementation approach
- 💻 Coder: Implementing the solution
- 🧪 Tester: Writing tests
- 👀 Reviewer: Code review and security check

They're working in parallel. I'll synthesize their results when they complete.
```

### 🚫 DO NOT:
- Continuously check swarm status
- Poll TaskOutput repeatedly
- Add more tool calls after spawning
- Ask "should I check on the agents?"

### ✅ DO:
- Spawn all agents in ONE message
- Tell user what's happening
- Wait for agent results to arrive
- Synthesize results when they return

## 🧠 AUTO-LEARNING PROTOCOL

### Before Starting Any Task
```bash
# 1. Search memory for relevant patterns from past successes
Bash("npx @claude-flow/cli@latest memory search --query '[task keywords]' --namespace patterns")

# 2. Check if similar task was done before
Bash("npx @claude-flow/cli@latest memory search --query '[task type]' --namespace tasks")

# 3. Load learned optimizations
Bash("npx @claude-flow/cli@latest hooks route --task '[task description]'")
```

### After Completing Any Task Successfully
```bash
# 1. Store successful pattern for future reference
Bash("npx @claude-flow/cli@latest memory store --namespace patterns --key '[pattern-name]' --value '[what worked]'")

# 2. Train neural patterns on the successful approach
Bash("npx @claude-flow/cli@latest hooks post-edit --file '[main-file]' --train-neural true")

# 3. Record task completion with metrics
Bash("npx @claude-flow/cli@latest hooks post-task --task-id '[id]' --success true --store-results true")

# 4. Trigger optimization worker if performance-related
Bash("npx @claude-flow/cli@latest hooks worker dispatch --trigger optimize")
```

### Continuous Improvement Triggers

| Trigger | Worker | When to Use |
|---------|--------|-------------|
| After major refactor | `optimize` | Performance optimization |
| After adding features | `testgaps` | Find missing test coverage |
| After security changes | `audit` | Security analysis |
| After API changes | `document` | Update documentation |
| Every 5+ file changes | `map` | Update codebase map |
| Complex debugging | `deepdive` | Deep code analysis |

### Memory-Enhanced Development

**ALWAYS check memory before:**
- Starting a new feature (search for similar implementations)
- Debugging an issue (search for past solutions)
- Refactoring code (search for learned patterns)
- Performance work (search for optimization strategies)

**ALWAYS store in memory after:**
- Solving a tricky bug (store the solution pattern)
- Completing a feature (store the approach)
- Finding a performance fix (store the optimization)
- Discovering a security issue (store the vulnerability pattern)

### 📋 Agent Routing (Anti-Drift)

| Code | Task | Agents |
|------|------|--------|
| 1 | Bug Fix | coordinator, researcher, coder, tester |
| 3 | Feature | coordinator, architect, coder, tester, reviewer |
| 5 | Refactor | coordinator, architect, coder, reviewer |
| 7 | Performance | coordinator, perf-engineer, coder |
| 9 | Security | coordinator, security-architect, auditor |
| 11 | Docs | researcher, api-docs |

**Codes 1-9: hierarchical/specialized (anti-drift). Code 11: mesh/balanced**

### 🎯 Task Complexity Detection

**AUTO-INVOKE SWARM when task involves:**
- Multiple files (3+)
- New feature implementation
- Refactoring across modules
- API changes with tests
- Security-related changes
- Performance optimization
- Database schema changes

**SKIP SWARM for:**
- Single file edits
- Simple bug fixes (1-2 lines)
- Documentation updates
- Configuration changes
- Quick questions/exploration

## 🚨 CRITICAL: CONCURRENT EXECUTION & FILE MANAGEMENT

**ABSOLUTE RULES**:
1. ALL operations MUST be concurrent/parallel in a single message
2. **NEVER save working files, text/mds and tests to the root folder**
3. ALWAYS organize files in appropriate subdirectories
4. **USE CLAUDE CODE'S TASK TOOL** for spawning agents concurrently, not just MCP

### ⚡ GOLDEN RULE: "1 MESSAGE = ALL RELATED OPERATIONS"

**MANDATORY PATTERNS:**
- **TodoWrite**: ALWAYS batch ALL todos in ONE call (5-10+ todos minimum)
- **Task tool (Claude Code)**: ALWAYS spawn ALL agents in ONE message with full instructions
- **File operations**: ALWAYS batch ALL reads/writes/edits in ONE message
- **Bash commands**: ALWAYS batch ALL terminal operations in ONE message
- **Memory operations**: ALWAYS batch ALL memory store/retrieve in ONE message

### 📁 File Organization Rules

**NEVER save to root folder. Use these directories:**
- `/src` - Source code files
- `/tests` - Test files
- `/docs` - Documentation and markdown files
- `/config` - Configuration files
- `/scripts` - Utility scripts
- `/examples` - Example code

## Project Config (Anti-Drift Defaults)

- **Topology**: hierarchical (prevents drift)
- **Max Agents**: 8 (smaller = less drift)
- **Strategy**: specialized (clear roles)
- **Consensus**: raft
- **Memory**: hybrid
- **HNSW**: Enabled
- **Neural**: Enabled

## 🚀 V3 CLI Commands (26 Commands, 140+ Subcommands)

### Core Commands

| Command | Subcommands | Description |
|---------|-------------|-------------|
| `init` | 4 | Project initialization with wizard, presets, skills, hooks |
| `agent` | 8 | Agent lifecycle (spawn, list, status, stop, metrics, pool, health, logs) |
| `swarm` | 6 | Multi-agent swarm coordination and orchestration |
| `memory` | 11 | AgentDB memory with vector search (150x-12,500x faster) |
| `mcp` | 9 | MCP server management and tool execution |
| `task` | 6 | Task creation, assignment, and lifecycle |
| `session` | 7 | Session state management and persistence |
| `config` | 7 | Configuration management and provider setup |
| `status` | 3 | System status monitoring with watch mode |
| `workflow` | 6 | Workflow execution and template management |
| `hooks` | 17 | Self-learning hooks + 12 background workers |
| `hive-mind` | 6 | Queen-led Byzantine fault-tolerant consensus |

### Advanced Commands

| Command | Subcommands | Description |
|---------|-------------|-------------|
| `daemon` | 5 | Background worker daemon (start, stop, status, trigger, enable) |
| `neural` | 5 | Neural pattern training (train, status, patterns, predict, optimize) |
| `security` | 6 | Security scanning (scan, audit, cve, threats, validate, report) |
| `performance` | 5 | Performance profiling (benchmark, profile, metrics, optimize, report) |
| `providers` | 5 | AI providers (list, add, remove, test, configure) |
| `plugins` | 5 | Plugin management (list, install, uninstall, enable, disable) |
| `deployment` | 5 | Deployment management (deploy, rollback, status, environments, release) |
| `embeddings` | 4 | Vector embeddings (embed, batch, search, init) - 75x faster with agentic-flow |
| `claims` | 4 | Claims-based authorization (check, grant, revoke, list) |
| `migrate` | 5 | V2 to V3 migration with rollback support |
| `doctor` | 1 | System diagnostics with health checks |
| `completions` | 4 | Shell completions (bash, zsh, fish, powershell) |

### Quick CLI Examples

```bash
# Initialize project
npx @claude-flow/cli@latest init --wizard

# Start daemon with background workers
npx @claude-flow/cli@latest daemon start

# Spawn an agent
npx @claude-flow/cli@latest agent spawn -t coder --name my-coder

# Initialize swarm
npx @claude-flow/cli@latest swarm init --v3-mode

# Search memory (HNSW-indexed)
npx @claude-flow/cli@latest memory search --query "authentication patterns"

# System diagnostics
npx @claude-flow/cli@latest doctor --fix

# Security scan
npx @claude-flow/cli@latest security scan --depth full

# Performance benchmark
npx @claude-flow/cli@latest performance benchmark --suite all
```

## 🚀 Available Agents (60+ Types)

### Core Development
`coder`, `reviewer`, `tester`, `planner`, `researcher`

### V3 Specialized Agents
`security-architect`, `security-auditor`, `memory-specialist`, `performance-engineer`

### 🔐 @claude-flow/security
CVE remediation, input validation, path security:
- `InputValidator` - Zod validation
- `PathValidator` - Traversal prevention
- `SafeExecutor` - Injection protection

### Swarm Coordination
`hierarchical-coordinator`, `mesh-coordinator`, `adaptive-coordinator`, `collective-intelligence-coordinator`, `swarm-memory-manager`

### Consensus & Distributed
`byzantine-coordinator`, `raft-manager`, `gossip-coordinator`, `consensus-builder`, `crdt-synchronizer`, `quorum-manager`, `security-manager`

### Performance & Optimization
`perf-analyzer`, `performance-benchmarker`, `task-orchestrator`, `memory-coordinator`, `smart-agent`

### GitHub & Repository
`github-modes`, `pr-manager`, `code-review-swarm`, `issue-tracker`, `release-manager`, `workflow-automation`, `project-board-sync`, `repo-architect`, `multi-repo-swarm`

### SPARC Methodology
`sparc-coord`, `sparc-coder`, `specification`, `pseudocode`, `architecture`, `refinement`

### Specialized Development
`backend-dev`, `mobile-dev`, `ml-developer`, `cicd-engineer`, `api-docs`, `system-architect`, `code-analyzer`, `base-template-generator`

### Testing & Validation
`tdd-london-swarm`, `production-validator`

## 🪝 V3 Hooks System (27 Hooks + 12 Workers)

### All Available Hooks

| Hook | Description | Key Options |
|------|-------------|-------------|
| `pre-edit` | Get context before editing files | `--file`, `--operation` |
| `post-edit` | Record editing outcome for learning | `--file`, `--success`, `--train-neural` |
| `pre-command` | Assess risk before commands | `--command`, `--validate-safety` |
| `post-command` | Record command execution outcome | `--command`, `--track-metrics` |
| `pre-task` | Record task start, get agent suggestions | `--description`, `--coordinate-swarm` |
| `post-task` | Record task completion for learning | `--task-id`, `--success`, `--store-results` |
| `session-start` | Start/restore session (v2 compat) | `--session-id`, `--auto-configure` |
| `session-end` | End session and persist state | `--generate-summary`, `--export-metrics` |
| `session-restore` | Restore a previous session | `--session-id`, `--latest` |
| `route` | Route task to optimal agent | `--task`, `--context`, `--top-k` |
| `route-task` | (v2 compat) Alias for route | `--task`, `--auto-swarm` |
| `explain` | Explain routing decision | `--topic`, `--detailed` |
| `pretrain` | Bootstrap intelligence from repo | `--model-type`, `--epochs` |
| `build-agents` | Generate optimized agent configs | `--agent-types`, `--focus` |
| `metrics` | View learning metrics dashboard | `--v3-dashboard`, `--format` |
| `transfer` | Transfer patterns via IPFS registry | `store`, `from-project` |
| `list` | List all registered hooks | `--format` |
| `intelligence` | RuVector intelligence system | `trajectory-*`, `pattern-*`, `stats` |
| `worker` | Background worker management | `list`, `dispatch`, `status`, `detect` |
| `progress` | Check V3 implementation progress | `--detailed`, `--format` |
| `statusline` | Generate dynamic statusline | `--json`, `--compact`, `--no-color` |
| `coverage-route` | Route based on test coverage gaps | `--task`, `--path` |
| `coverage-suggest` | Suggest coverage improvements | `--path` |
| `coverage-gaps` | List coverage gaps with priorities | `--format`, `--limit` |
| `pre-bash` | (v2 compat) Alias for pre-command | Same as pre-command |
| `post-bash` | (v2 compat) Alias for post-command | Same as post-command |

### 12 Background Workers

| Worker | Priority | Description |
|--------|----------|-------------|
| `ultralearn` | normal | Deep knowledge acquisition |
| `optimize` | high | Performance optimization |
| `consolidate` | low | Memory consolidation |
| `predict` | normal | Predictive preloading |
| `audit` | critical | Security analysis |
| `map` | normal | Codebase mapping |
| `preload` | low | Resource preloading |
| `deepdive` | normal | Deep code analysis |
| `document` | normal | Auto-documentation |
| `refactor` | normal | Refactoring suggestions |
| `benchmark` | normal | Performance benchmarking |
| `testgaps` | normal | Test coverage analysis |

### Essential Hook Commands

```bash
# Core hooks
npx @claude-flow/cli@latest hooks pre-task --description "[task]"
npx @claude-flow/cli@latest hooks post-task --task-id "[id]" --success true
npx @claude-flow/cli@latest hooks post-edit --file "[file]" --train-neural true

# Session management
npx @claude-flow/cli@latest hooks session-start --session-id "[id]"
npx @claude-flow/cli@latest hooks session-end --export-metrics true
npx @claude-flow/cli@latest hooks session-restore --session-id "[id]"

# Intelligence routing
npx @claude-flow/cli@latest hooks route --task "[task]"
npx @claude-flow/cli@latest hooks explain --topic "[topic]"

# Neural learning
npx @claude-flow/cli@latest hooks pretrain --model-type moe --epochs 10
npx @claude-flow/cli@latest hooks build-agents --agent-types coder,tester

# Background workers
npx @claude-flow/cli@latest hooks worker list
npx @claude-flow/cli@latest hooks worker dispatch --trigger audit
npx @claude-flow/cli@latest hooks worker status

# Coverage-aware routing
npx @claude-flow/cli@latest hooks coverage-gaps --format table
npx @claude-flow/cli@latest hooks coverage-route --task "[task]"

# Statusline (for Claude Code integration)
npx @claude-flow/cli@latest hooks statusline
npx @claude-flow/cli@latest hooks statusline --json
```

## 🔄 Migration (V2 to V3)

```bash
# Check migration status
npx @claude-flow/cli@latest migrate status

# Run migration with backup
npx @claude-flow/cli@latest migrate run --backup

# Rollback if needed
npx @claude-flow/cli@latest migrate rollback

# Validate migration
npx @claude-flow/cli@latest migrate validate
```

## 🧠 Intelligence System (RuVector)

V3 includes the RuVector Intelligence System:
- **SONA**: Self-Optimizing Neural Architecture (<0.05ms adaptation)
- **MoE**: Mixture of Experts for specialized routing
- **HNSW**: 150x-12,500x faster pattern search
- **EWC++**: Elastic Weight Consolidation (prevents forgetting)
- **Flash Attention**: 2.49x-7.47x speedup

The 4-step intelligence pipeline:
1. **RETRIEVE** - Fetch relevant patterns via HNSW
2. **JUDGE** - Evaluate with verdicts (success/failure)
3. **DISTILL** - Extract key learnings via LoRA
4. **CONSOLIDATE** - Prevent catastrophic forgetting via EWC++

## 📦 Embeddings Package (v3.0.0-alpha.12)

Features:
- **sql.js**: Cross-platform SQLite persistent cache (WASM, no native compilation)
- **Document chunking**: Configurable overlap and size
- **Normalization**: L2, L1, min-max, z-score
- **Hyperbolic embeddings**: Poincaré ball model for hierarchical data
- **75x faster**: With agentic-flow ONNX integration
- **Neural substrate**: Integration with RuVector

## 🐝 Hive-Mind Consensus

### Topologies
- `hierarchical` - Queen controls workers directly
- `mesh` - Fully connected peer network
- `hierarchical-mesh` - Hybrid (recommended)
- `adaptive` - Dynamic based on load

### Consensus Strategies
- `byzantine` - BFT (tolerates f < n/3 faulty)
- `raft` - Leader-based (tolerates f < n/2)
- `gossip` - Epidemic for eventual consistency
- `crdt` - Conflict-free replicated data types
- `quorum` - Configurable quorum-based

## V3 Performance Targets

| Metric | Target |
|--------|--------|
| Flash Attention | 2.49x-7.47x speedup |
| HNSW Search | 150x-12,500x faster |
| Memory Reduction | 50-75% with quantization |
| MCP Response | <100ms |
| CLI Startup | <500ms |
| SONA Adaptation | <0.05ms |

## 📊 Performance Optimization Protocol

### Automatic Performance Tracking
```bash
# After any significant operation, track metrics
Bash("npx @claude-flow/cli@latest hooks post-command --command '[operation]' --track-metrics true")

# Periodically run benchmarks (every major feature)
Bash("npx @claude-flow/cli@latest performance benchmark --suite all")

# Analyze bottlenecks when performance degrades
Bash("npx @claude-flow/cli@latest performance profile --target '[component]'")
```

### Session Persistence (Cross-Conversation Learning)
```bash
# At session start - restore previous context
Bash("npx @claude-flow/cli@latest session restore --latest")

# At session end - persist learned patterns
Bash("npx @claude-flow/cli@latest hooks session-end --generate-summary true --persist-state true --export-metrics true")
```

### Neural Pattern Training
```bash
# Train on successful code patterns
Bash("npx @claude-flow/cli@latest neural train --pattern-type coordination --epochs 10")

# Predict optimal approach for new tasks
Bash("npx @claude-flow/cli@latest neural predict --input '[task description]'")

# View learned patterns
Bash("npx @claude-flow/cli@latest neural patterns --list")
```

## 🔧 Environment Variables

```bash
# Configuration
CLAUDE_FLOW_CONFIG=./claude-flow.config.json
CLAUDE_FLOW_LOG_LEVEL=info

# Provider API Keys
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
GOOGLE_API_KEY=...

# MCP Server
CLAUDE_FLOW_MCP_PORT=3000
CLAUDE_FLOW_MCP_HOST=localhost
CLAUDE_FLOW_MCP_TRANSPORT=stdio

# Memory
CLAUDE_FLOW_MEMORY_BACKEND=hybrid
CLAUDE_FLOW_MEMORY_PATH=./data/memory
```

## 🔍 Doctor Health Checks

Run `npx @claude-flow/cli@latest doctor` to check:
- Node.js version (20+)
- npm version (9+)
- Git installation
- Config file validity
- Daemon status
- Memory database
- API keys
- MCP servers
- Disk space
- TypeScript installation

## 🚀 Quick Setup

```bash
# Add MCP servers (auto-detects MCP mode when stdin is piped)
claude mcp add claude-flow -- npx -y @claude-flow/cli@latest
claude mcp add ruv-swarm -- npx -y ruv-swarm mcp start  # Optional
claude mcp add flow-nexus -- npx -y flow-nexus@latest mcp start  # Optional

# Start daemon
npx @claude-flow/cli@latest daemon start

# Run doctor
npx @claude-flow/cli@latest doctor --fix
```

## 🎯 Claude Code vs CLI Tools

### Claude Code Handles ALL EXECUTION:
- **Task tool**: Spawn and run agents concurrently
- File operations (Read, Write, Edit, MultiEdit, Glob, Grep)
- Code generation and programming
- Bash commands and system operations
- TodoWrite and task management
- Git operations

### CLI Tools Handle Coordination (via Bash):
- **Swarm init**: `npx @claude-flow/cli@latest swarm init --topology <type>`
- **Swarm status**: `npx @claude-flow/cli@latest swarm status`
- **Agent spawn**: `npx @claude-flow/cli@latest agent spawn -t <type> --name <name>`
- **Memory store**: `npx @claude-flow/cli@latest memory store --key "mykey" --value "myvalue" --namespace patterns`
- **Memory search**: `npx @claude-flow/cli@latest memory search --query "search terms"`
- **Memory list**: `npx @claude-flow/cli@latest memory list --namespace patterns`
- **Memory retrieve**: `npx @claude-flow/cli@latest memory retrieve --key "mykey" --namespace patterns`
- **Hooks**: `npx @claude-flow/cli@latest hooks <hook-name> [options]`

## 📝 Memory Commands Reference (IMPORTANT)

### Store Data (ALL options shown)
```bash
# REQUIRED: --key and --value
# OPTIONAL: --namespace (default: "default"), --ttl, --tags
npx @claude-flow/cli@latest memory store --key "pattern-auth" --value "JWT with refresh tokens" --namespace patterns
npx @claude-flow/cli@latest memory store --key "bug-fix-123" --value "Fixed null check" --namespace solutions --tags "bugfix,auth"
```

### Search Data (semantic vector search)
```bash
# REQUIRED: --query (full flag, not -q)
# OPTIONAL: --namespace, --limit, --threshold
npx @claude-flow/cli@latest memory search --query "authentication patterns"
npx @claude-flow/cli@latest memory search --query "error handling" --namespace patterns --limit 5
```

### List Entries
```bash
# OPTIONAL: --namespace, --limit
npx @claude-flow/cli@latest memory list
npx @claude-flow/cli@latest memory list --namespace patterns --limit 10
```

### Retrieve Specific Entry
```bash
# REQUIRED: --key
# OPTIONAL: --namespace (default: "default")
npx @claude-flow/cli@latest memory retrieve --key "pattern-auth"
npx @claude-flow/cli@latest memory retrieve --key "pattern-auth" --namespace patterns
```

### Initialize Memory Database
```bash
npx @claude-flow/cli@latest memory init --force --verbose
```

**KEY**: CLI coordinates the strategy via Bash, Claude Code's Task tool executes with real agents.

## 📚 Full Capabilities Reference

For a comprehensive overview of all Claude Flow V3 features, agents, commands, and integrations, see:

**`.claude-flow/CAPABILITIES.md`** - Complete reference generated during init

This includes:
- All 60+ agent types with routing recommendations
- All 26 CLI commands with 140+ subcommands
- All 27 hooks + 12 background workers
- RuVector intelligence system details
- Hive-Mind consensus mechanisms
- Integration ecosystem (agentic-flow, agentdb, ruv-swarm, flow-nexus, agentic-jujutsu)
- Performance targets and status

## 🏗️ Cognitum Seed Release Build Process

### Build armhf Binary (Pi Zero 2 W)
```bash
# Build via Docker (cross-compile for ARM 32-bit)
MSYS_NO_PATHCONV=1 docker build -f Dockerfile.armhf -t cognitum-armhf:vX.Y.Z .

# Extract binary
MSYS_NO_PATHCONV=1 docker create --name cvXYZ cognitum-armhf:vX.Y.Z /bin/true
docker cp cvXYZ:/cognitum-agent ./cognitum-agent-vX.Y.Z-arm
docker rm cvXYZ

# Generate SHA256
sha256sum cognitum-agent-vX.Y.Z-arm > cognitum-agent-vX.Y.Z-arm.sha256
```

### Build SD Card Image — CORRECT APPROACH (Proven 2026-04-09)

**DO NOT use debugfs to write the binary** — produces corrupt inodes ("Structure needs cleaning").
**DO NOT use Docker to patch images** — corrupts networking.
**DO NOT use `create-release-image.sh`** — sanitization breaks the seed.
**DO NOT capture from 64GB cards** — image doesn't fit on 16GB cards.

The ONLY proven method:

```bash
# Step 1: Flash v0.8.1 base image on 16GB SD card
#   Use Raspberry Pi Imager or:
#   gunzip -c cognitum-seed-v0.8.1.img.gz | sudo dd of=/dev/rdiskN bs=4m

# Step 2: Boot seed with the card (plug into USB, wait 60-90s)
#   The v0.8.1 base boots on any Pi Zero 2 W

# Step 3: Deploy latest binary via SSH (NOT debugfs)
bash scripts/cognitum/update-seed.sh
#   This uses SCP over SSH (genesis/cognitum password)
#   Binary, certs, scripts all deployed via clean file copy

# Step 4: Verify everything works
#   http://169.254.42.1/guide  — full guide with Cog Store link
#   http://169.254.42.1/store  — 88 cogs listed
#   http://169.254.42.1/       — API explorer with mesh/apps sections
#   /api/v1/upgrade/check      — version should be 0.10.x

# Step 5: Sanitize on the RUNNING seed via SSH
ssh genesis@169.254.42.1 "
  sudo rm -f /var/lib/cognitum/device-id /var/lib/cognitum/device-key /var/lib/cognitum/device-key.pub
  sudo rm -f /var/lib/cognitum/tls/cert.pem /var/lib/cognitum/tls/key.pem /var/lib/cognitum/tls/ca.pem
  sudo rm -f /var/lib/cognitum/tls/local-ca.pem /var/lib/cognitum/tls/local-ca.key /var/lib/cognitum/tls/local-ca.srl
  sudo rm -f /var/lib/cognitum/tls/device-tls.key /var/lib/cognitum/tls/.using-local-ca
  sudo rm -f /var/lib/cognitum/paired /var/lib/cognitum/clients.json
  sudo rm -f /var/lib/cognitum/mesh-config.json /var/lib/cognitum/mesh-password /var/lib/cognitum/auto-mesh-enabled
  sudo rm -rf /var/lib/cognitum/apps/* /var/lib/cognitum/rvf-store/*
  sudo rm -f /etc/NetworkManager/system-connections/*.nmconnection
  rm -f ~/.ssh/authorized_keys ~/.bash_history
  sudo rm -f /root/.ssh/authorized_keys /root/.bash_history
  sudo shutdown -h now"

# Step 6: Wait 10s, unplug USB, pull SD card

# Step 7: Capture image (Mac Mini card reader — read-only dd)
diskutil unmountDisk /dev/diskN
sudo dd if=/dev/rdiskN bs=4m | gzip -1 > cognitum-seed-vX.Y.Z.img.gz
shasum -a 256 cognitum-seed-vX.Y.Z.img.gz > cognitum-seed-vX.Y.Z.img.gz.sha256

# Step 8: Flash to a DIFFERENT card and boot-test before publishing
gunzip -c cognitum-seed-vX.Y.Z.img.gz | sudo dd of=/dev/rdiskM bs=4m
# Boot in seed, verify guide/store/mesh all work, fresh device-id generated
```

**CRITICAL — what NOT to do:**
- **NEVER use debugfs `write`** to put the binary on the SD card. It corrupts inodes on macOS.
  The binary MUST be deployed via SCP/SSH to a running seed.
- **NEVER modify gadget.img** on a running seed then unplug — corrupts the FAT image.
- **NEVER sanitize via debugfs** — do it via SSH on the running seed before shutdown.
- **NEVER publish an image without boot-testing on a different card first.**

**Why this works:**
- v0.8.1 base boots on any Pi (proven first-boot scripts + USB gadget)
- SCP produces clean file copies (no inode corruption)
- Sanitization on a running seed uses normal filesystem ops (no debugfs)
- dd capture is read-only (no writes to source card)
- Boot-test on a different card catches any issues before publishing
- Creates .needs-first-boot sentinel
- Fixes CRLF line endings
- Restores the seed after capture

**TLS Key Format:**
- Use `openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:prime256v1` (PKCS#8 format)
- Do NOT use `openssl ecparam -genkey` — outputs EC PARAMETERS format which rustls cannot read
- Key must start with `-----BEGIN PRIVATE KEY-----` (not `BEGIN EC PARAMETERS`)

### Known Issues (Lessons Learned 2026-03-30 / 2026-04-01)
- **Docker image patching breaks networking** — never use update-image.sh or kpartx
- **Agent restart kills USB** — setup-gadget.sh rebinds USB, Windows creates phantom adapters
- **SSH reboot kills USB** — never `sudo reboot` via SSH on USB-connected seed
- **64GB cards timeout** — dd takes 60+ min, SSH drops. Always use 16GB
- **USB SSH drops during dd** — even 16GB can drop. Use WiFi for capture
- **First-boot must use EXIT trap** for sentinel removal — systemd timeout kills ExecStartPost
- **RVF proof attestation** — binary metadata in ENTRY_META_ONLY broke JSON replay chain. Fixed with unwrap_or_default()
- **TLS key format** — `ecparam -genkey` outputs wrong format for rustls. Use `genpkey` (PKCS#8)
- **Windows Public firewall** — blocks 169.254.42.1 on every replug. Set to Private via admin PowerShell
- **create-release-image.sh fails if seed not fully booted** — wait for agent "active" before running
- **create-release-image.sh corrupts seed** — sanitization + restore cycle breaks networking. Use direct SD read instead

### Mac Mini Image Build (via Tailscale)

**Mac Mini:** `cohen@100.123.117.38` (Tailscale), macOS ARM64, Homebrew + e2fsprogs installed.

**Method:** Use `debugfs` (e2fsprogs) to write files directly to the ext4 rootfs partition on the SD card — no mounting, no SSH streaming, no corruption.

```bash
# Prerequisites (already installed on Mac Mini):
#   brew install e2fsprogs macfuse

# Step 1: Insert SD card (flashed with v0.8.1 base) into Mac Mini USB reader
diskutil list  # Find the disk, e.g., /dev/disk4
diskutil unmountDisk /dev/disk4

# Step 2: Copy files into ext4 rootfs using debugfs (read-write, no mount)
DISK=/dev/disk4s2
sudo /opt/homebrew/opt/e2fsprogs/sbin/debugfs -w $DISK << 'EOF'
# Binary
write /tmp/cognitum-agent-v0.10.0-arm /opt/cognitum/cognitum-agent
# Scripts
write /tmp/auto-first-boot.sh /opt/cognitum/scripts/auto-first-boot.sh
write /tmp/first-boot.sh /opt/cognitum/scripts/first-boot.sh
write /tmp/auto-ca-cert.sh /opt/cognitum/scripts/auto-ca-cert.sh
# Guide
write /tmp/guide.html /opt/cognitum/guide.html
# Systemd services
write /tmp/cognitum-first-boot.service /etc/systemd/system/cognitum-first-boot.service
write /tmp/cognitum-auto-cert.service /etc/systemd/system/cognitum-auto-cert.service
write /tmp/cognitum-auto-cert.timer /etc/systemd/system/cognitum-auto-cert.timer
EOF

# Step 3: Fix permissions (debugfs sets root:root by default)
sudo /opt/homebrew/opt/e2fsprogs/sbin/debugfs -w $DISK -R "set_inode_field /opt/cognitum/cognitum-agent mode 0755"
sudo /opt/homebrew/opt/e2fsprogs/sbin/debugfs -w $DISK -R "set_inode_field /opt/cognitum/scripts/auto-first-boot.sh mode 0755"
sudo /opt/homebrew/opt/e2fsprogs/sbin/debugfs -w $DISK -R "set_inode_field /opt/cognitum/scripts/first-boot.sh mode 0755"
sudo /opt/homebrew/opt/e2fsprogs/sbin/debugfs -w $DISK -R "set_inode_field /opt/cognitum/scripts/auto-ca-cert.sh mode 0755"

# Step 4: Enable auto-cert timer symlink
sudo /opt/homebrew/opt/e2fsprogs/sbin/debugfs -w $DISK -R "symlink /etc/systemd/system/timers.target.wants/cognitum-auto-cert.timer /etc/systemd/system/cognitum-auto-cert.timer"

# Step 5: Test in Pi — insert SD card, boot, verify http://169.254.42.1/guide

# Step 6: Capture image (after verification)
diskutil unmountDisk /dev/disk4
sudo dd if=/dev/rdisk4 bs=4m status=progress | gzip -1 > cognitum-seed-v0.10.0.img.gz
shasum -a 256 cognitum-seed-v0.10.0.img.gz > cognitum-seed-v0.10.0.img.gz.sha256
diskutil eject /dev/disk4
```

**Why debugfs:** macOS cannot mount ext4 natively. ext4fuse doesn't work on ARM Macs. `debugfs` from e2fsprogs can read and write ext4 filesystems directly without mounting — it operates on the raw block device. No Docker, no SSH, no corruption.

### Update Guide/Index Without Recompiling
```bash
# The binary loads guide.html and index.html from disk first:
#   /var/lib/cognitum/guide.html  (checked first)
#   /opt/cognitum/guide.html      (fallback)
#   Embedded HTML                  (final fallback)
scp guide.html genesis@169.254.42.1:/tmp/
scp index.html genesis@169.254.42.1:/tmp/
ssh genesis@169.254.42.1 "sudo cp /tmp/guide.html /var/lib/cognitum/ && \
  sudo cp /tmp/index.html /var/lib/cognitum/"
```

### Update USB Gadget Drive
```bash
ssh genesis@169.254.42.1 "
sudo mount -o loop /opt/cognitum/gadget.img /mnt/gadget
sudo cp /tmp/guide.html /mnt/gadget/
sudo cp /tmp/api.html /mnt/gadget/   # standalone API explorer
sudo umount /mnt/gadget
sudo systemctl restart cognitum-gadget  # WARNING: resets USB connection
"
```

### Publish GitHub Release
```bash
gh release create vX.Y.Z \
  cognitum-agent-vX.Y.Z-arm \
  cognitum-agent-vX.Y.Z-arm.sha256 \
  scripts/cognitum/usb-drive/guide.html \
  --repo ruvnet/optimizer --target master \
  --title "vX.Y.Z — Title" --notes "Release notes..."
```

### 🔴 MANDATORY: Release Image Verification

**NEVER publish a release image without verifying the binary inside it matches the version tag.**

**Before capturing an SD card image:**
```bash
# 1. Boot the seed from the SD card
# 2. Verify the binary version via API
curl -sk http://169.254.42.1/api/v1/status | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'Binary reports: vectors={d.get(\"total_vectors\",0)}')"

# 3. Verify store is embedded (NOT "Cog Store not installed")
curl -sk http://169.254.42.1/store | head -c 50
# MUST show "<!DOCTYPE html>" not error message

# 4. Verify mesh endpoint exists
curl -sk http://169.254.42.1/api/v1/mesh/status | head -c 50
# MUST NOT show "not found"

# 5. Verify binary size matches what was compiled
ssh genesis@169.254.42.1 "ls -l /opt/cognitum/cognitum-agent"
# Size must match the Docker-extracted binary
```

**After capturing the image:**
```bash
# 6. Flash the image to a DIFFERENT SD card
# 7. Boot from it and repeat checks 1-5
# 8. Only THEN publish to GitHub
```

**What caused the v0.10.0 mistake:** Image was captured from a seed running v0.8.1 base, labeled as v0.10.0 without booting and verifying. The binary may not have been deployed before capture, or the capture was from the wrong SD card.

**Rule: Version tag = binary version inside the image. Always verify by booting.**

### Deploy to Live Pi
```bash
scp cognitum-agent-vX.Y.Z-arm genesis@169.254.42.1:~/
ssh genesis@169.254.42.1 "sudo systemctl stop cognitum-agent && \
  sudo cp ~/cognitum-agent-vX.Y.Z-arm /opt/cognitum/cognitum-agent && \
  sudo chmod 755 /opt/cognitum/cognitum-agent && \
  sudo systemctl start cognitum-agent"
```

### 🔴 MANDATORY: OTA/Deploy Verification Checklist

**After ANY binary deploy (OTA or manual), ALWAYS verify ALL of these on the actual seed:**

```bash
# Run from Mac Mini (cohen@100.123.117.38) targeting the seed IP
IP=192.168.1.106  # or whichever seed was updated

# 1. Guide loads (should return 200, ~188KB)
curl -sk -o /dev/null -w "Guide: %{http_code} %{size_download}b\n" http://$IP/guide

# 2. Store loads (should return 200, ~97KB — NOT "Cog Store not installed")
curl -sk -o /dev/null -w "Store: %{http_code} %{size_download}b\n" http://$IP/store

# 3. Store has actual HTML content (not error message)
curl -sk http://$IP/store | head -c 50
# MUST show "<!DOCTYPE html>" not "Cog Store not installed"

# 4. Apps API returns cogs from cloud
curl -sk http://$IP/api/v1/apps/available | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('cogs',[])),'cogs')"

# 5. Mesh endpoint exists
curl -sk http://$IP/api/v1/mesh/status | head -c 80
# Should show mesh data or "Bearer token required" (NOT "not found")

# 6. Data preserved (vectors and paired state survive OTA)
curl -sk http://$IP/api/v1/status | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'vectors={d[\"total_vectors\"]} paired={d[\"paired\"]}')"

# 7. Mesh config auto-created (if first boot with mesh binary)
sshpass -p cognitum ssh genesis@$IP 'test -f /var/lib/cognitum/mesh-config.json && echo "mesh-config: EXISTS" || echo "mesh-config: MISSING"'
```

**If ANY check fails, the deploy is NOT complete.** Common failures:
- Store returns "not installed" → `cog-store.html` not embedded (use `include_str!` in api.rs)
- Mesh returns "not found" → binary compiled without `--features mesh`
- Apps returns empty → GCS registry URL wrong or seed has no internet
- Vectors = 0 → data dir was wiped (should never happen with OTA)

**Key rule: Checking HTTP status codes (200/401/403) is NOT sufficient.**
You MUST check the response BODY to confirm real content is served, not error messages with 200 status.

### Docker Mesh Test (3 seeds)
```bash
cd scripts/cognitum/docker-mesh-test
docker compose up --build -d
# Seeds at: http://localhost:8001, :8002, :8003
bash test-mesh.sh
docker compose down
```

### Pi Zero vs Pi 5 Differences
| Feature | Pi Zero 2 W (Seed) | Pi 5 (Hub) |
|---------|-------------------|------------|
| Arch | armhf (32-bit) | aarch64 (64-bit) |
| Binary | `Dockerfile.armhf` | `docker/cognitum-v0/build.sh` |
| Display | None (headless) | SPI TFT 480x320 |
| USB | Gadget mode (169.254.42.1) | Host mode |
| Setup WiFi | Exclusive (takes over wlan0) | Concurrent (wlan0_ap virtual) |
| Config | `dtoverlay=dwc2` | No dwc2 needed |

## Support

- Documentation: https://github.com/ruvnet/claude-flow
- Issues: https://github.com/ruvnet/claude-flow/issues

---

Remember: **Claude Flow CLI coordinates, Claude Code Task tool creates!**

# important-instruction-reminders
Do what has been asked; nothing more, nothing less.
NEVER create files unless they're absolutely necessary for achieving your goal.
ALWAYS prefer editing an existing file to creating a new one.
NEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested by the User.
Never save working files, text/mds and tests to the root folder.

## 🚨 SWARM EXECUTION RULES (CRITICAL)
1. **SPAWN IN BACKGROUND**: Use `run_in_background: true` for all agent Task calls
2. **SPAWN ALL AT ONCE**: Put ALL agent Task calls in ONE message for parallel execution
3. **TELL USER**: After spawning, list what each agent is doing (use emojis for clarity)
4. **STOP AND WAIT**: After spawning, STOP - do NOT add more tool calls or check status
5. **NO POLLING**: Never poll TaskOutput or check swarm status - trust agents to return
6. **SYNTHESIZE**: When agent results arrive, review ALL results before proceeding
7. **NO CONFIRMATION**: Don't ask "should I check?" - just wait for results

Example spawn message:
```
"I've launched 4 agents in background:
- 🔍 Researcher: [task]
- 💻 Coder: [task]
- 🧪 Tester: [task]
- 👀 Reviewer: [task]
Working in parallel - I'll synthesize when they complete."
```
