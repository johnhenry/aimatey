---
"@johnhenry/aimatey-types": minor
---

Adapters that front another machine can now say what a proxy must do about cancellation, forwarding and capabilities, instead of each author guessing (#121, #124, #127). All additions are optional; **no existing adapter or caller breaks**.

- `BackendAdapter.cancel?(requestId, reason?)`: ask the far side to stop. Keyed on `IRMetadata.requestId`, so it cancels the whole logical request including a fallback in flight. `AbortSignal` stays the in-process mechanism and the authority for settling the caller; `cancel` is called in addition to it. Documented on `execute`: a proxy must still settle promptly when the signal fires, and a stream cancelled mid-turn ends with a `done` chunk of `finishReason: 'cancelled'` whose `message` carries the partial output, or throws the abort error, never silently.
- `BackendAdapter.discoverCapabilities?(signal?)` and `AdapterMetadata.capabilitiesResolved?`: `AdapterMetadata.capabilities` is now documented as the **static lower bound** (a placeholder for an adapter whose far side can change); discovery replaces it as the resolved view.
- Documented contract (no type change): what a proxying adapter may forward, in `docs/IR-FORMAT.md` "Forwarding across a proxy".
- `RouterConfig.capabilityCacheDuration` now also bounds how long a discovered capability answer is trusted.
