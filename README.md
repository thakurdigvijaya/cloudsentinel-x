CLOUDSENTINEL X
Intelligent, Explainable & Safety-First Cloud Cost Optimization

"Don't just trust our optimizer. Challenge it."

PROJECT OVERVIEW

CloudSentinel X is an intelligent cloud infrastructure optimization and decision-support platform developed for the UTHO SmartCloud Optimizer challenge at TransfiNITTe 2026, National Institute of Technology Tiruchirappalli.

Modern cloud environments frequently suffer from oversized virtual machines, idle infrastructure, unattached resources, inefficient spending, and unpredictable workload patterns.

Traditional cloud dashboards primarily display utilization and expenditure. CloudSentinel X goes further by analyzing historical infrastructure data, identifying potential savings, evaluating operational risks, and explaining why particular optimization decisions should or should not be implemented.

Our central philosophy is simple: the best optimization is not necessarily the one that saves the most money, but the one that delivers defensible savings without unnecessarily compromising reliability.

LIVE WEBSITE

https://cloudsentinelx.pages.dev/

The public website demonstrates CloudSentinel X's browser-based analytical features. The authenticated Secure Team Workspace requires separate backend hosting and configuration.

PROBLEM STATEMENT

CloudSentinel X addresses the UTHO SmartCloud Optimizer challenge.

The objective is to help organizations understand cloud resource utilization, identify infrastructure inefficiencies, generate actionable optimization recommendations, estimate potential savings, and evaluate operational risks.

The system is designed around the requirements of a mid-sized cloud environment operating across multiple Indian regions.

CORE FEATURES

1. Intelligent Command Center

A centralized infrastructure dashboard providing cloud resource visibility, utilization trends, financial insights, cost breakdowns, and projected savings.

2. Smart Optimization Engine

A rule-based, data-driven optimization engine that analyzes CPU, memory, historical workload patterns, resource configurations, and utilization peaks.

It identifies oversized virtual machines, potentially idle resources, unattached storage, unused public IP addresses, and scheduling opportunities.

Recommendations include estimated savings, supporting evidence, and risk evaluations.

3. Challenge the Optimizer

Our signature interactive feature allows users to challenge optimization recommendations by simulating changing workload conditions.

Instead of blindly recommending cost reductions, the system recalculates eligibility and identifies recommendations that become unsafe under increased demand.

In the tested synthetic scenario, increasing workload stress by 60% reduces eligible optimization changes from 59 to 51.

This demonstrates the platform's ability to refuse potentially unsafe cost-saving decisions.

4. ForeSight

Provides forecasting and forward-looking workload insights to support infrastructure planning and help anticipate changing resource requirements.

5. Dependency Shield

Analyzes relationships between infrastructure resources and helps prevent conflicting or unsafe optimization decisions involving dependent workloads.

6. ProofGate

Provides explainable optimization reasoning, supporting utilization evidence, safety assessments, and decision transparency.

7. Financial Intelligence

Calculates estimated monthly infrastructure expenditure, projected optimization savings, before-and-after costs, and approval-aware financial summaries.

The application distinguishes potential savings from approved decisions and does not misrepresent projected savings as realized financial reductions.

8. Alerts and Insights

Identifies unusual resource utilization, workload anomalies, capacity concerns, and potential budget overruns.

9. Utsav Mode

Allows infrastructure teams to evaluate optimization decisions under anticipated workload increases, special events, and high-demand conditions.

10. Secure Team Workspace

Provides backend-supported organization accounts, authentication, invitation workflows, role-based permissions, organization isolation, saved decisions, and audit history.

The authenticated team workspace and original browser-local analytical screens currently maintain separate decision states.

TECHNOLOGY STACK

Frontend:
React
TypeScript
Vite
Responsive interface
Interactive dashboards and visualizations

Backend:
Node.js
TypeScript
HTTP API
Session-based authentication
Role-based access control
Organization-specific data isolation
File-backed persistence

Optimization and Analytics:
Rule-based recommendation engine
Historical workload analysis
Peak-aware safety evaluation
Dependency checking
Cost estimation
Forecasting
Anomaly detection
Interactive scenario simulation

The core optimization engine does not depend on an external language-model API.

DATASET AND SIMULATION

CloudSentinel X includes a reproducible synthetic cloud infrastructure dataset.

Virtual Machines: 90
Storage Volumes: 20
Public IP Addresses: 12
Total Resources: 122
Historical Coverage: 30 days
Metric Sampling Interval: 15 minutes

The dataset includes resource configurations, utilization measurements, pricing assumptions, and simulated workload patterns.

ILLUSTRATIVE FINANCIAL RESULTS

Estimated Monthly Infrastructure Cost: INR 835,622
Estimated Eligible Monthly Savings: INR 218,850
Initially Eligible Optimization Changes: 59
Eligible Changes After 60% Workload Stress: 51

These figures are generated using synthetic infrastructure data and modeled pricing assumptions. They do not represent actual realized savings from a live cloud provider.

INSTALLATION AND LOCAL SETUP

Requirements:

Node.js version 22.12 or newer
npm
Git
A modern web browser

Step 1: Clone the GitHub repository and open the project directory containing package.json.

Step 2: Install dependencies.

npm install

Step 3: Verify source integrity.

npm run verify:source

Step 4: Run automated tests.

npm test

Step 5: Create a production build.

npm run build

Step 6: Start the frontend development server.

npm run dev

The development server normally runs at:

http://localhost:5173/

Step 7: Open a second terminal and start the backend.

npm run server

The local backend normally listens on port 8787.

Step 8: Access the application.

Command Center:
http://localhost:5173/#/home

Secure Team Workspace:
http://localhost:5173/#/team

Both development servers must remain running for local authenticated workflows.

TESTING AND VERIFICATION

The latest security-updated version was tested on Windows on October 25, 2026.

Source Verification: Passed
Required Files Checked: 11
Source Files Checked: 103
Local Imports Checked: 472
Automated Test Files: 32 passed
Automated Tests: 293 passed
TypeScript Compilation: Passed
Vite Production Build: Passed
npm Security Audit: 0 reported vulnerabilities

Tested dependency versions included Vite 6.4.5 and Vitest 5.0.5.

These results describe the tested environment. They do not guarantee the absence of application security vulnerabilities or establish production deployment readiness.

DEPLOYMENT

The frontend is deployed using Cloudflare Pages.

Public URL:
https://cloudsentinelx.pages.dev/

The frontend is built using npm run build, which generates the dist directory containing deployable static assets.

The Node.js backend requires a compatible hosting platform, HTTPS API configuration, secure session handling, and durable storage.

The public frontend deployment does not automatically host the backend or enable public Secure Team authentication.

SECURITY AND ACCESS CONTROL

CloudSentinel X includes server-side authentication, organization isolation, role-specific permissions, session handling, and auditable decisions.

Automated tests cover authentication workflows, permission enforcement, organization separation, decision persistence, and session invalidation.

Sensitive credentials, session files, environment secrets, and organization data should never be committed to a public repository.

Production deployment requires additional security review and appropriate persistent storage configuration.

CURRENT LIMITATIONS

CloudSentinel X is a functional software prototype rather than a fully integrated production cloud management service.

Current limitations include:

Synthetic rather than live cloud-provider telemetry.
Modeled pricing rather than verified cloud billing.
No automatic execution of real cloud infrastructure changes.
Separate browser-local and authenticated team decision states.
Additional backend configuration required for public authentication.
Provider-specific performance and capacity assumptions requiring further validation.
Large-scale concurrent-user performance not yet fully established.

These limitations are documented to distinguish demonstrated functionality from future implementation goals.

FUTURE DEVELOPMENT

Potential future improvements include live cloud-provider integrations, unified server-backed analytics, scalable persistent data storage, provider-specific capacity validation, production observability, and broader performance benchmarking.

These are proposed improvements, not claims about the current implementation.

OUR INNOVATION

CloudSentinel X introduces a safety-first approach to cloud optimization.

Rather than focusing exclusively on maximum theoretical savings, the platform evaluates whether proposed optimizations remain defensible under real-world operational constraints.

Its distinctive capability is Challenge the Optimizer, which allows users to test recommendations against simulated workload changes and understand why certain savings opportunities must be rejected.

CloudSentinel X aims to make cloud optimization transparent, explainable, interactive, and accountable.

PROJECT INFORMATION

Project Name: CloudSentinel X

Hackathon: TransfiNITTe 2026

Domain: Software Development

Problem Statement: UTHO SmartCloud Optimizer

Institution: National Institute of Technology Tiruchirappalli

TAGLINE

Intelligent Optimization. Explainable Decisions. Safety Before Savings.

"Don't just trust our optimizer. Challenge it."
