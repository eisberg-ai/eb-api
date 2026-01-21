#### Worker

In a production environment, we test the worker framework. Using API endpoints and whatnot.

##### Mock

Worker timing summary (aggregate, seconds):

| Metric | Min | Max | Avg |
| --- | --- | --- | --- |
| handle_job_runtime | 73.797254 | 114.283282 | 85.1369136 |
| claim_to_build_start | 0.0 | 0.0 | 0.0 |
| submit_to_build_start | 0.0 | 0.0 | 0.0 |
| submit_to_build_end | 0.0 | 0.0 | 0.0 |

Agent timing summary (5 runs, seconds):

| Step | Min | Max | Avg |
| --- | --- | --- | --- |
| setup_context | 2.854 | 15.625 | 6.2876 |
| restore_source | 0.32 | 0.522 | 0.3842 |
| prepare_inputs | 0.337 | 0.643 | 0.4494 |
| install_dependencies | 7.627 | 8.758 | 8.0124 |
| build_app | 15.147 | 18.687 | 16.7858 |
| finalize_build | 43.111 | 48.992 | 45.9036 |
| total | 73.422 | 113.659 | 84.6106 |

##### Default

SKIP

##### Deployed

Kubernetes

###### Mock

###### Default

SKIP


### Kubernetes/Infra/API Updates
- [ ] Keep warm capacity (min replicas 1–2) and enable image pre-pull on nodes to eliminate cold starts.
- [ ] Add a lockfile-keyed cache volume (PV or remote) for `node_modules` and Expo caches.
- [ ] Prefer shorter, frequent heartbeats and detect stalled jobs faster to reduce wasted time.
- [ ] Add a lightweight “build timings” API endpoint for dashboarding p50/p95 and stage budget alerts.
