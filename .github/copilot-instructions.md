# Local MLX consultation

Use `local_llm_status` before an explicit local-model consultation when availability is unknown. Use `local_llm_delegate` only for bounded, read-only advisory work with the minimum relevant paths. Prefer `fast` for focused work and `deep` for difficult multi-file reasoning. Validate every useful finding against repository evidence and tests. Never use these tools to start, stop, load, unload, or swap models; report structured availability, quality-mismatch, busy, cooldown, and startup-hint results to the user.
