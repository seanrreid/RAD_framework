# Sources and verification

[Guide](README.md) · [Indexes](indexes.md)

## Source Key

| Key | Source | Type / bias note |
|---|---|---|
| <a id="etn"></a>ETN | "Software Factory at Etnetera" (Excalidraw deck, 40 slides; synthesis of a conference talk) | Figures and anecdotes are speaker-reported; deck marks which claims are aspiration vs. in use |
| <a id="horthy"></a>HORTHY | Dex Horthy, "Why Software Factories Fail" (AI Engineer 2026) | Experience-based; HumanLayer sells related tooling |
| <a id="ubr-t"></a>UBR-T | Uday Kiran Medisetty, "Running a Software Factory Efficiently at Uber Scale" (Uber blog, 2026-08-27) | First-party measured results; Uber sells no agents |
| <a id="faik"></a>FAIK | Adam Faik, "How to build an AI-native software factory" (The AI Thinker, 2026-10-05) | Secondary synthesis of 70+ public sources; includes a PostHog demo |
| <a id="swz"></a>SWZ | Swizec Teller, "When code is cheap, judgement becomes the job" (2026-10-08) | One 21-person team, first-person |
| <a id="jx0"></a>JX0 | "Building Autonomous Goal Loops That Deliver" (2026-08-20) | Design argument, no metrics |
| <a id="baro"></a>BARO | "Anatomy of a Software Factory: How baro Runs Concurrent Coding Agents on Mozaik" | Author sells Mozaik and runs a hackathon; candid about failures; numbers from own run ledger |
| <a id="detail"></a>DETAIL | Dan Robinson, "Towards Self-Driving Codebases" (Detail, 2026-09-02) | Vendor positioning; Detail is hiring/launching a product on this thesis |
| <a id="lloyd"></a>LLOYD | Zach Lloyd, X post/article (2026-09-29) | Warp sells Warp Factories |
| <a id="stencil"></a>STENCIL | Can Bölük, "The Harness Playbook" (2026-09-02) | Author of a competing harness (omp/omp²); fully read. Parts of omp² are "shipped to still being thought through" per the author, so design claims are not all validated |
| <a id="dfs"></a>DFS | "Building an Advanced Agentic Harness" (Data For Science) | Tutorial; uses mocks; no eval yet |
| <a id="tunguz"></a>TUNGUZ | Tomasz Tunguz, "Thinking in Systems, Shipping in Loops" (2026-09-24, 3 min read) | Short essay by a venture investor; cites portfolio-company figures and DHH's Rails World keynote; no measurements of its own |
| <a id="builder"></a>BUILDER | Alice Moore, "Build an agent loop a small model can finish" (Builder.io, 2026-10-01; the 2026-09-29 related-articles card refers to a separate post) | Vendor blog for its open-source Agent-Native framework; two tasks, one author team; numbers are first-party and unreplicated |
| <a id="wieruch"></a>WIERUCH | Robin Wieruch, "Agentic Coding: Bet on the Primitives" (2026-07-31) | One freelance spike |
| <a id="handbook"></a>HANDBOOK | Harness Handbook (Tencent HY, 2026-06) | Research project on behaviour-level maps of harnesses; fully read. Authors built the tool and ran the evaluation with LLM judges |

## Source links

Canonical URLs for the 15 sources reviewed (tracking parameters such as `utm_source` and `via` removed).

| Key | URL |
|---|---|
| ETN | <https://link.excalidraw.com/p/readonly/iVt8jmN6UHMFT3BWPAal> (Excalidraw+ read-only presentation; the original link carried a `startFrame` parameter whose value was redacted in the session) |
| HORTHY | <https://ai.engineer/talks/Ib5GBkD555M-why-software-factories-fail> |
| UBR-T | <https://www.uber.com/us/en/blog/efficient-software-factory/> |
| FAIK | <https://www.theaithinker.com/p/how-to-build-an-ai-native-software> |
| SWZ | <https://swizec.com/blog/when-code-is-cheap-judgement-becomes-the-job> |
| JX0 | <https://jx0.ca/building-autonomous-goal-loops-that-deliver/> |
| BARO | <https://mozaik.jigjoy.ai/blog/anatomy-of-a-software-factory> |
| DETAIL | <https://blog.detail.dev/posts/towards-self-driving-codebases/> |
| LLOYD | <https://x.com/zachlloydtweets/status/2104957956794057068> |
| STENCIL | <https://stencil.so/blog/harness-playbook> |
| DFS | <https://data4sci.com/blog/building-an-advanced-agentic-harness> |
| WIERUCH | <https://www.robinwieruch.de/agentic-coding-bet-on-primitives/> |
| HANDBOOK | <https://ruhan-wang.github.io/Harness-Handbook/> |
| BUILDER | <https://www.builder.io/blog/build-an-agent-loop-a-small-model-can-finish> |
| TUNGUZ | <https://tomtunguz.com/thinking-in-systems> (added after the first 14; supplied by the user) |

### Verification log (originals opened 2026-10-09)

Figures that the checks take from secondary sources were compared against the original pages. Each claim below matches the original unless a note says otherwise.

| Claim in this document | Original | Result |
|---|---|---|
| Median time in review up 441.5%; 22,000 developers | Faros AI report page (<https://www.faros.ai/blog/ai-acceleration-whiplash-takeaways>) | Confirmed. The report states it tracks change between each organisation's lowest and highest AI-adoption periods, so it is a before/after comparison, not a controlled one. Faros sells engineering analytics. |
| 76% more PRs to review; 2.5 million automated maintenance PRs | Spotify engineering (<https://engineering.atspotify.com/2026/6/code-with-claude-coding-is-no-longer-the-constraint>) | Confirmed: "76% increase in pull request frequency", "76% more PRs to review", and "more than 2.5 million automated maintenance PRs, the vast majority auto-merged with no human in the loop". |
| LiteLLM poisoned releases live about 40 minutes; official Docker image unaffected | LiteLLM incident report (<https://docs.litellm.ai/blog/security-update-march-2026>) | Confirmed: live from 10:39 UTC on 2026-03-24 for about 40 minutes before PyPI quarantined them; the official proxy Docker image pins dependencies and was not impacted. The report was an active investigation when published. The Datadog analysis, which Faik cites for what was stolen, was opened in the second pass below. |
| Uber first-review time 3 hours (2024) to 9 hours (2026) | AI Engineer talk page for uReview (<https://ai.engineer/talks/EL123UNokkI-building-ureview-ubers-multi-agent-code-review>) | Confirmed in the page text ("three hours in 2024 to nine hours in 2026"). The page is a written summary of the talk, not the video. |
| Uber monthly $1,500 cap; annual AI budget spent in four months | TechCrunch (<https://techcrunch.com/2026/06/02/uber-caps-employee-ai-spending-after-blowing-through-budget-in-four-months/>) | Confirmed, with sourcing noted: TechCrunch relays Bloomberg for the cap and says Uber's CTO revealed the four-month budget overrun in April. Faik's "costs up 6x since 2024" is not on this page; it was confirmed in the second pass at the Pragmatic Engineer article. |
| Intercom: AI-authored backend code reverted 0.53% vs 5.39% human | Intercom blog (<https://www.intercom.com/blog/ai-is-approving-our-pull-requests-heres-how-we-made-it-safe/>) | Confirmed. The same page reports zero reverts of AI-approved PRs and a 6-16x improvement in time-to-approval at the 75th percentile. First-party figures. |
| Intercom tripled merged PRs per R&D employee in 16 months | Fin/Intercom post (<https://ideas.fin.ai/p/2x-nine-months-later>) | Partly confirmed: "looking back over 16 months we've 3x'd". Only that sentence was extracted, so the per-R&D-employee metric definition was not checked. |
| 83% lower token cost from better file structure | Martin Fowler's site (<https://martinfowler.com/articles/exploring-gen-ai/refactoring-economic-benefit.html>) | Confirmed with limits: see C7. |

Second pass (originals opened the same day, covering the items first left unverified):

| Claim in this document | Original | Result |
|---|---|---|
| Uber AI costs up 6x since 2024; 92% of devs use agents monthly; 11% of PRs opened by agents; "top-down mandates are less efficient"; boring work moved to AI raised satisfaction | Pragmatic Engineer, How Uber uses AI (<https://newsletter.pragmaticengineer.com/p/how-uber-uses-ai-for-development>) | Confirmed, all five. This is where Faik's 6x comes from (the earlier TechCrunch page did not state it). |
| Uber COO: "very hard to draw a line" from usage to useful features | Fortune (<https://fortune.com/2026/05/26/uber-coo-ai-spending-tokens-claude-code/>) | Confirmed: the COO says it is hard to connect rising Claude Code use to consumer-facing innovation. |
| Uber JUnit 5 migration: 75,000+ test classes, 1.25M lines, 4 months, 5,000+ diffs; multi-file generative-AI attempt unsuccessful | Uber blog (<https://www.uber.com/us/en/blog/junit-migration/>) | Confirmed, all of it. |
| Spotify: 1,500+ merged PRs; 60-90% time saving on those migrations | Spotify, Honk part 1 | Confirmed ("total time saving of 60-90% compared to writing the code by hand"). |
| Spotify: LLM judge vetoes about a quarter of sessions; agent course-corrects half the time | Spotify, Honk part 3 | Confirmed, with Spotify's own caveat: "We have yet to invest in evals for our judge." |
| Spotify: ~1,800 downstream pipelines; about 10 engineering weeks saved | Spotify, Honk part 4 | Confirmed ("estimated 10 engineering weeks"). |
| Stripe: devboxes ready in 10 seconds; 1,000+ PRs a week (part 1), 1,300+ (part 2), human-reviewed with no human-written code; blueprints mix deterministic and agent nodes; Toolshed has nearly 500 MCP tools but each agent gets a small subset | Stripe Minions parts 1 and 2 | Confirmed, all of it. |
| Ramp: 60% of PRs by January (two months after v2), 75% by May; under 5 seconds to spin up; 5.5-person team (four engineers, a director, part-time PM); did not force use; rebuilds images every 30 minutes; "most important metric": sessions ending in a merged PR | Pragmatic Engineer, Ramp Inspect, and Ramp's own post | Confirmed, all of it. |
| Shopify: River co-authors one in eight merged PRs; "not a thing that could be a hundred Rivers"; "$1,000 per month more ... 10% more productive, that's too cheap" | Shopify Engineering and First Round | Confirmed. |
| DoorDash: laptops hold SSH/VPN/authenticated tools, large blast radius; start-up SLO under five seconds; private channels did not create team habits; 10,000+ PR reviews a week across 56 repos; any comment can tag a fixer agent | DoorDash engineering, two posts | Confirmed. Note the five-second figure is a 95th-percentile service-level objective, not an average. |
| Meta Rule of Two (at most two of: untrusted input, sensitive access, can change state or communicate externally) | Meta AI blog | Confirmed. |
| Meta: 50+ agents, 59 context files, 40% fewer tool calls | Meta engineering blog | Confirmed as "preliminary tests on six tasks". |
| Warp fraud-bot runs every 8 hours; one run found and wrote PRs against nearly $60K of fraudulent usage | Warp blog (Oz announcement) | Confirmed (a single run "one morning"); Warp sells the platform. |
| Duolingo dropped AI use from performance reviews | Yahoo Finance | Confirmed: nearly a year after announcing it, the CEO said the company has let that metric go. |
| Amazon employees ran trivial tasks to climb a token leaderboard | Fortune on FT reporting | Confirmed ("reportedly"). Meta's leaderboard coming down was not located on that page. |
| Replit agent deleted a live database during a code freeze | Fortune | Confirmed as "reportedly". |
| AWS tool chose to "delete and recreate the environment", 13-hour outage | The Decoder, summarising Financial Times | Confirmed as reported by four anonymous sources. Amazon disputes the framing: the engineer had "broader permissions than expected - a user access control issue, not an AI autonomy issue". Treat as contested. |
| GitHub MCP: a malicious issue hijacks an agent to leak private repository data | Invariant Labs | Confirmed (a research disclosure from a security vendor). |
| LiteLLM compromise: credential exposure | Datadog Security Labs | Confirmed in substance: versions 1.82.7 and 1.82.8 should be treated as a "full-credential exposure event", with credential scraping and exfiltration described. The exact list "cloud keys, SSH keys, Kubernetes data, CI secrets" was not checked item by item. |
| Lauren Tan ships about 2,000 PRs a month; verification is the key | The New Stack | Confirmed, as her own claim; verification is her stated critical piece. |
| Anthropic: stages write intent.md, spec.md, plan.md and the next stage reads them; the incident-response agent contacted another Claude instance on its own initiative and a human review gate caught it; shadow mode for new AI reviewers | Anthropic playbook and security post | Confirmed. The source says the agent "reached out over Slack to another Claude instance"; Faik's "to push a fix" was not located. |

Follow-up review (2026-10-09): the Anthropic playbook directly confirms the production-gate wording, `REVIEW.md`, and the `claude -p` example. Artemis's LinkedIn posts were opened and confirm 30,000 PRs in eight months and 2/6/16 merged PRs per engineer per day; the posts use relative dates for the latter periods, so May/August remains Tunguz's interpretation.

Still not verified: the Meta leaderboard having "come down" and the per-R&D-employee definition behind Intercom's 3x. Faros's observational before/after design does not establish causation. The Etnetera deck's figures remain speaker-reported with no outside source.

### Secondary links cited by FAIK

The Faik article cites these. They were initially extracted from the article's link list; many were subsequently opened, as recorded in the Verification log. Checks retain FAIK as their synthesis source. Use the log to distinguish claims checked against originals from those still unverified. Fetched link text is the article's own wording.

**Uber**

- Talk on its software factory (video): <https://www.youtube.com/watch?v=17-YSUHo6Lk>
- Building uReview talk: <https://ai.engineer/talks/EL123UNokkI-building-ureview-ubers-multi-agent-code-review> (video: <https://www.youtube.com/watch?v=EL123UNokkI>)
- uReview: <https://www.uber.com/us/en/blog/ureview/>
- JUnit 5 migration: <https://www.uber.com/us/en/blog/junit-migration/>
- uSpec: <https://www.uber.com/us/en/blog/automate-design-specs/>
- Agent identity: <https://www.uber.com/us/en/blog/solving-the-agent-identity-crisis/>
- Code Inbox (Background Agents Summit): <https://background-agents.com/summit/sessions/nikhil-ramakrishnan/>
- Pragmatic Engineer, how Uber uses AI for development: <https://newsletter.pragmaticengineer.com/p/how-uber-uses-ai-for-development>
- TechCrunch, Uber caps AI spending: <https://techcrunch.com/2026/06/02/uber-caps-employee-ai-spending-after-blowing-through-budget-in-four-months/>
- Fortune, Uber COO on AI spending and tokens: <https://fortune.com/2026/05/26/uber-coo-ai-spending-tokens-claude-code/>

**Anthropic**

- AI-native SDLC playbook: <https://claude.com/blog/the-ai-native-sdlc-playbook>
- How Anthropic secures its AI-native SDLC: <https://claude.com/blog/how-anthropic-secures-its-ai-native-software-development-lifecycle>
- How AI is transforming work at Anthropic: <https://www.anthropic.com/research/how-ai-is-transforming-work-at-anthropic>
- Claude Code on the web: <https://code.claude.com/docs/en/claude-code-on-the-web>

**Spotify**

- Background coding agent, part 1: <https://engineering.atspotify.com/2025/11/spotifys-background-coding-agent-part-1>
- Part 2, context engineering: <https://engineering.atspotify.com/2025/11/context-engineering-background-coding-agents-part-2>
- Part 3, feedback loops: <https://engineering.atspotify.com/2025/12/feedback-loops-background-coding-agents-part-3>
- Part 4, dataset migrations (Honk): <https://engineering.atspotify.com/2026/4/background-coding-agents-dataset-migrations-honk-part-4>
- Coding is no longer the constraint: <https://engineering.atspotify.com/2026/6/code-with-claude-coding-is-no-longer-the-constraint>

**Stripe**

- Minions, part 1: <https://stripe.dev/blog/minions-stripes-one-shot-end-to-end-coding-agents>
- Minions, part 2: <https://stripe.dev/blog/minions-stripes-one-shot-end-to-end-coding-agents-part-2>

**DoorDash**

- Delegating engineering work to cloud-based agents: <https://careersatdoordash.com/blog/delegating-engineering-work-to-cloud-based-agents/>
- How we learned to trust our AI code reviewer: <https://careersatdoordash.com/blog/how-we-learned-to-trust-our-ai-code-reviewer-at-doordash/>
- An AI code reviewer engineers actually listen to: <https://careersatdoordash.com/blog/doordash-built-an-ai-code-reviewer-engineers-actually-listen-to/>

**Ramp**

- Why we built our background agent: <https://builders.ramp.com/post/why-we-built-our-background-agent>
- Pragmatic Engineer, why Ramp built Inspect: <https://newsletter.pragmaticengineer.com/p/why-ramp-built-inspect>
- How Ramp built its agent on Modal: <https://modal.com/blog/how-ramp-built-a-full-context-background-coding-agent-on-modal>

**Shopify**

- Farhan Thawar, First Round: <https://www.firstround.com/ai/shopify>
- Under the River: <https://shopify.engineering/under-the-river>
- Introducing Roast: <https://shopify.engineering/introducing-roast>
- Model-agnostic AI stack (VentureBeat): <https://venturebeat.com/orchestration/how-shopify-built-an-ai-stack-that-doesnt-care-which-models-survive>
- Tobi Lütke's AI usage memo: <https://x.com/tobi/status/1909251946235437514>

**Intercom**

- 2x, nine months later: <https://ideas.fin.ai/p/2x-nine-months-later>
- AI is approving our pull requests: <https://www.intercom.com/blog/ai-is-approving-our-pull-requests-heres-how-we-made-it-safe/>

**Meta**

- Mapping tribal knowledge with AI: <https://engineering.fb.com/2026/04/06/developer-tools/how-meta-used-ai-to-map-tribal-knowledge-in-large-scale-data-pipelines/>
- The Rule of Two: <https://ai.meta.com/blog/practical-ai-agent-security/>

**Warp**

- Oz orchestration platform (fraud-bot): <https://www.warp.dev/blog/oz-orchestration-platform-cloud-agents>
- Zach Lloyd's AI Engineer talk: <https://ai.engineer/talks/tUPPVhBBcoM> (video: <https://www.youtube.com/watch?v=tUPPVhBBcoM>)

**Other companies and commentary**

- LinkedIn's Prince Valluri on InfoQ: <https://www.infoq.com/podcasts/platform-engineering-scaling-agents/>
- Honeycomb, 30 to 70 PRs a day: <https://www.honeycomb.io/blog/30-70-prs-day-how-we-managed-not-wreck-systems>
- Coinbase, agent-first development (Linear customer story): <https://linear.app/customers/coinbase>
- Duolingo, "I'm not going to force you": <https://finance.yahoo.com/sectors/technology/articles/m-not-going-force-duolingo-170215712.html>
- Token leaderboards at Meta and Amazon (Fortune): <https://fortune.com/2026/05/12/amazon-tokenmaxxing-claude-ai-capex-meta-gil-luria/>
- Charity Majors, Pragmatic Engineer: <https://newsletter.pragmaticengineer.com/p/stop-being-skeptical-about-ai-for>
- Faik's earlier post on picking agents: <https://www.theaithinker.com/p/how-to-pick-the-ai-agents-worth-building>
- PostHog repository (used in the Faik demo): <https://github.com/PostHog/posthog>

**Research and frameworks**

- DORA 2025 AI-assisted software development report: <https://services.google.com/fh/files/misc/2025_state_of_ai_assisted_software_development.pdf>
- DORA AI capabilities model: <https://services.google.com/fh/files/misc/2025_dora_ai_capabilities_model.pdf>
- Faros AI, AI acceleration whiplash: <https://www.faros.ai/blog/ai-acceleration-whiplash-takeaways>
- DX AI measurement framework: <https://getdx.com/blog/ai-measurement-framework-guide/>
- Google SRE book, eliminating toil: <https://sre.google/sre-book/eliminating-toil/>
- Team Topologies, thinnest viable platform: <https://teamtopologies.com/key-concepts-content/what-is-a-thinnest-viable-platform-tvp>
- Martin Fowler, harness engineering: <https://martinfowler.com/articles/harness-engineering.html>

**Incidents**

- LiteLLM March 2026 security update: <https://docs.litellm.ai/blog/security-update-march-2026>
- Datadog analysis of the LiteLLM compromise: <https://securitylabs.datadoghq.com/articles/litellm-compromised-pypi-teampcp-supply-chain-campaign/>
- Replit deleted database (Fortune): <https://fortune.com/2025/07/23/ai-coding-tool-replit-wiped-database-called-it-a-catastrophic-failure/>
- AWS coding tool, 13-hour outage (The Decoder): <https://the-decoder.com/aws-ai-coding-tool-decided-to-delete-and-recreate-a-customer-facing-system-causing-13-hour-outage-report-says/>
- GitHub MCP exploit (Invariant Labs): <https://invariantlabs.ai/blog/mcp-github-vulnerability>

**Building blocks on the market**

- Model gateways: LiteLLM <https://docs.litellm.ai/docs/simple_proxy> · Portkey <https://portkey.ai/docs/product/ai-gateway> · Kong <https://developer.konghq.com/ai-gateway/> · Cloudflare <https://developers.cloudflare.com/ai-gateway/> · Bedrock inference profiles <https://docs.aws.amazon.com/bedrock/latest/userguide/inference-profiles.html>
- Sandboxes: AWS AgentCore Runtime <https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/agents-tools-runtime.html> · Modal <https://modal.com/docs/guide/sandboxes> · E2B <https://docs.e2b.dev/> · Daytona <https://www.daytona.io/docs/en/> · Ona <https://ona.com/docs/ona/getting-started> · Coder <https://coder.com/docs/ai-coder>
- Tool gateways: MCP <https://modelcontextprotocol.io/docs/getting-started/intro> · Docker MCP Gateway <https://docs.docker.com/ai/mcp-catalog-and-toolkit/mcp-gateway/> · AgentCore Gateway <https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway.html> · Microsoft Foundry <https://learn.microsoft.com/en-us/azure/foundry/agents/overview>
- Hosted agent: Copilot cloud agent <https://docs.github.com/en/copilot/concepts/agents/cloud-agent/about-cloud-agent>
- Tracing: OpenTelemetry GenAI conventions <https://github.com/open-telemetry/semantic-conventions-genai>

### Secondary links cited by HORTHY

Extracted from the talk page's link list; not opened.

- StrongDM's software factory: <https://www.strongdm.com/blog/the-strongdm-software-factory-building-software-with-ai>
- Faros AI engineering findings: <https://www.faros.ai/blog/ai-acceleration-whiplash-takeaways>
- SWE-bench Multilingual: <https://swe-agent-bench.github.io/multilingual.html>
- SWE-Marathon (paper): <https://arxiv.org/abs/2606.07682>
- DeepSWE (Datacurve): <https://deepswe.datacurve.ai/>
- FrontierCode (Cognition): <https://cognition.com/blog/frontier-code>
- HumanLayer: <https://www.humanlayer.com/>
- "Skill Issue: Harness Engineering for Coding Agents": <https://www.humanlayer.com/blog/skill-issue-harness-engineering-for-coding-agents>
- Talk video: <https://www.youtube.com/watch?v=Ib5GBkD555M> · speaker page: <https://ai.engineer/speakers/dex-horthy>

### Links cited by the other sources

Extracted from each page's own link list; the linked pages were not opened. Navigation, share buttons, legal, tag and category links are omitted. The Uber blog post links to its conference talk in the introduction; that link is listed in the Uber section above. The Harness Handbook has no outbound article-body links identified in the extraction. The Etnetera Excalidraw deck's inter-slide diagram links were not extracted.

**JX0 (Building Autonomous Goal Loops)**

- The Convergence Problem: <https://jx0.ca/the-convergence-problem/>

**BARO (baro on Mozaik)**

- baro repository: <https://github.com/jigjoy-ai/baro> · site: <https://baro.rs/>
- Mozaik repository: <https://github.com/jigjoy-io/mozaik> · site: <https://mozaik.jigjoy.ai/>
- 808 passing NestJS tests run: <https://baro.rs/blog/baro-808-nestjs-jest-tests>
- Mozaik hackathon: <https://build.jigjoy.ai/hackathon-2026>

**DETAIL (Towards Self-Driving Codebases)**

- Where agents can't see (AI bug types): <https://blog.detail.dev/posts/ai-bug-types/>
- Detail: <https://detail.dev/>

**WIERUCH (Bet on the Primitives)**

- D3 charts (Apple Health): <https://www.robinwieruch.de/apple-health-chart-d3-js/>
- React libraries for 2026: <https://www.robinwieruch.de/react-libraries/>
- Agentic code review, pattern matching for AI: <https://www.robinwieruch.de/ai-agentic-code-review/>

**DFS (Advanced Agentic Harness)**

- Previous post, basic harness: <https://data4sci.substack.com/p/building-a-basic-agentic-harness>
- Pydantic: <https://pydantic.dev/docs/validation/latest/get-started/>
- DAG: <https://en.wikipedia.org/wiki/Directed_acyclic_graph> · Jaccard index: <https://en.wikipedia.org/wiki/Jaccard_index>
- all-MiniLM-L6-v2: <https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2>

**SWZ (Swizec Teller)**

- Auto-approve and merge PRs: <https://swizec.com/blog/we-now-auto-approve-and-merge-15p-of-prs>
- Big-bang migrations: <https://swizec.com/blog/agents-change-the-math-on-big-bang-migrations>
- AI writes 97% of my code: <https://swizec.com/blog/ai-now-writes-97-of-my-code-heres-what-i-learned>
- Watch people work: <https://swizec.com/blog/watch-people-work>
- Coaching AI to write your code: <https://swizec.com/blog/coaching-ai-to-write-your-code>
- Cursor background agents in Slack: <https://swizec.com/blog/cursor-background-agents-in-slack-changed-my-workflow>
- Stop burning tokens on code review (custom linters): <https://swizec.com/blog/stop-burning-tokens-on-code-review>
- Theory of constraints, AI, and code review: <https://swizec.com/blog/theory-of-constraints-ai-and-code-review/>
- Big ball of mud: <https://www.laputan.org/mud/mud.html>
- The file-structure token-cost experiment (83%), Martin Fowler's site: <https://martinfowler.com/articles/exploring-gen-ai/refactoring-economic-benefit.html>

**LLOYD (Warp)**

- Cloud software factories guide: <https://www.warp.dev/blog/a-guide-to-cloud-software-factories-for-engineering-leaders>
- Warp Factories: <http://www.warp.dev/factories> (docs: <https://docs.warp.dev/factories>)
- Crawl, walk, run adoption: <https://www.warp.dev/blog/adopting-the-software-factory-model-crawl-walk-run>
- Automations: <https://docs.warp.dev/factories/automations/> · Slack: <https://docs.warp.dev/factories/integrations/slack/> · Jira: <https://docs.warp.dev/factories/integrations/jira/>
- Spec-driven development skills: <https://www.warp.dev/blog/three-skills-for-spec-driven-development>
- Adversarial / self-improving code review: <https://www.warp.dev/blog/how-to-build-a-cloud-software-factory-self-improving-code-review>
- Computer-use artifacts in PRs: <https://docs.warp.dev/agents/capabilities/computer-use/artifacts-in-prs/>
- Factory dashboard: <https://docs.warp.dev/factories/factory-dashboard/> · Measure and improve: <https://docs.warp.dev/factories/measure-and-improve/>
- "We are now factory engineers": <https://www.warp.dev/blog/we-are-now-factory-engineers-not-product-engineers>
- LLM-as-a-judge scoring: <https://www.warp.dev/blog/using-llm-as-a-judge-scoring-to-measure-your-software-factory>
- Factory skills: <https://docs.warp.dev/factories/factory-skills/> · Model choice: <https://docs.warp.dev/agents/inference/model-choice/>
- Factory benchmarks: <https://www.warp.dev/blog/warp-factory-benchmarks> · Self-improving factories: <https://www.warp.dev/blog/agent-self-improving-software-factories>
- Harnesses: <https://docs.warp.dev/platform/harnesses/> · Open infrastructure: <https://www.warp.dev/blog/open-infrastructure-for-building-a-software-factory>
- Lloyd's earlier post: <https://x.com/zachlloydtweets/status/2093108611874472044>

**BUILDER (Builder.io)**

- Ralph loop (Geoffrey Huntley): <https://ghuntley.com/ralph/>
- Agent-Native: <https://www.agent-native.com/> · repository: <https://github.com/BuilderIO/agent-native>
- Figma interoperability notes: <https://github.com/BuilderIO/agent-native/blob/main/templates/design/FIGMA_INTEROPERABILITY.md>
- pixelmatch: <https://github.com/mapbox/pixelmatch> · ImageMagick compare: <https://imagemagick.org/compare/>
- Codex follow goals: <https://developers.openai.com/codex/use-cases/follow-goals> · Claude Code /goal: <https://code.claude.com/docs/en/goal>
- Visual recap ("Stop watching your agent work"): <https://www.builder.io/blog/stop-watching-your-agent-work>
- Pretext (Cheng Lou): <https://github.com/chenglou/pretext> · his post: <https://x.com/_chenglou/status/2037713766205608234>
- Build an agentic software factory, starting with one bug: <https://www.builder.io/blog/build-an-agentic-software-factory-starting-with-one-bug>
- Related posts: <https://www.builder.io/blog/how-to-use-webmcp> · <https://www.builder.io/blog/stop-installing-skills>

**STENCIL (Harness Playbook)**

- Conservation of complexity: <https://en.wikipedia.org/wiki/Law_of_conservation_of_complexity>
- Dijkstra, "simplicity is prerequisite for reliability" (EWD498): <https://www.cs.virginia.edu/~evans/cs655/readings/ewd498.html>
- Ousterhout lecture notes ("embrace suffering"): <https://web.stanford.edu/~ouster/cgi-bin/cs190-spring16/lecture.php>
- Valve ConVar: <https://developer.valvesoftware.com/wiki/ConVar>
- Pi image models: <https://github.com/earendil-works/pi/blob/main/packages/ai/src/image-models.ts>
- Prior post, tool-calling minutiae: <https://blog.can.ac/2026/08/03/the-minutiae-of-tool-calling/> · Snapcompact: <https://stencil.so/blog/snapcompact>
- pi-mono PR (renderer): <https://github.com/earendil-works/pi/pull/1084>
- ANSI escape injection references (the SOC Prime article covers both CVE-2025-55752, directory traversal, and CVE-2025-55754, ANSI escape injection; the latter is relevant here): <https://www.sentinelone.com/vulnerability-database/cve-2023-32712/> · <https://socprime.com/active-threats/cve-2025-55752/> · <https://github.com/boxdot/gurk-rs/issues/384> · <https://www.packetlabs.net/posts/weaponizing-ansi-escape-sequences/>
- TLA+: <https://lamport.azurewebsites.net/tla/tla.html> · Elastic Slots paper: <https://stencil.so/blog/harness-playbook/elastic-slots.pdf>
- The nine Pi extension examples audited in Appendix A are in <https://github.com/earendil-works/pi> under `packages/coding-agent/examples/extensions/` (git-checkpoint.ts, plan-mode/index.ts, status-line.ts, dynamic-tools.ts, snake.ts, bookmark.ts, kimi-deferred-tools.ts, auto-commit-on-exit.ts, tic-tac-toe.ts), pinned to commit 853a80d26c90a14c1886f0ebb8ffaae133ca2185

**TUNGUZ (Thinking in Systems)**

- Artemis, 30,000 PRs in eight months: <https://www.linkedin.com/posts/goartemis_this-week-artemis-passed-30000-prs-in-eight-activity-7496210981040279553-QsNz>
- Dan Shiebler (Artemis CTO): <https://www.linkedin.com/posts/dan-shiebler-10219b42_this-week-engineers-at-artemis-merged-an-activity-7496235403826581504-9fW9>
- Lauren Tan, Complete Guide to pstack: <https://x.com/poteto/status/2094457600259842065> · verification skill example: <https://github.com/poteto/verification-skill-example>
- The New Stack, "One engineer shipped 2,000 PRs a month": <https://thenewstack.io/agentic-verification-distributed-systems/>
- Meadows, Thinking in Systems: <https://www.amazon.com/Thinking-Systems-Donella-H-Meadows/dp/1603580557>
- Tunguz, Three Years In: <https://tomtunguz.com/three-years-in/>
- DHH, Rails World 2026 keynote: <https://youtu.be/vDjW_dRyKXY>

## Coverage status and remaining gaps

- **Builder.io**: now read (checks V17-V24, O18). The standard text extractor had grabbed a related-articles card (title "Build an agentic software factory, starting with one bug"), not the post; the real article was read from the page's `main` element. About 10 characters at the end of each fetched slice were cut, so a few sentences are partial; none of them change the checks.
- **Stencil Harness Playbook**: now fully read (the earlier cut-off was the text extractor's 50K default limit, not the page). Checks O13-O17, V14-V15, A11-A12 come from the previously unread chapters. The interface chapter's TUI-specific rendering and terminal-scrollback details are only summarised (A12, V15). Appendix B's TLA+ spec and PDF were not opened.
- **Harness Handbook**: now fully read (checks V16, K10-K12). The evaluation's result charts (exact win rates, token counts, recall/precision/F1) did not extract as text, so K11 is stated qualitatively.
- Screenshots of the Etnetera deck were read in-session but not saved to disk.

## Cross-source conflicts worth noting

- **Review bots**: Swizec found agentic review "okay" and rejected about half its comments; Uber/DoorDash/Spotify run specialised reviewers at scale with benchmarks and a model-judge veto. Likely difference: benchmarking and narrow scope vs. generic review. Unresolved.
- **Autonomy level**: Swizec auto-merges 16% of PRs; Horthy and Etnetera argue for restoring human review. They are not strictly incompatible (Swizec's auto-merge sits behind dozens of custom linters), but the threshold is unsettled.
- **Tool discovery**: Uber loads tools via search or CLI resolution to cut schema tokens (50-70K for 100+ tools); Stencil dislikes dynamic discovery because changing the roster invalidates the cache, and prefers a small fixed roster plus a stable `dyn` surface. Both agree the permanent roster must stay small; they differ on whether the long tail loads dynamically.
- **Process weight**: Etnetera/Horthy advocate heavy upfront spec and design; Swizec favors "ship first, ask questions later" for self-contained internal tools. Task risk seems to be the deciding variable.
