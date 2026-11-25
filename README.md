# Agent Drive

Your files in every agent, versioned and safe.

One owned home for your files and context, with a computer attached. Agents connect over MCP, state what they are doing, and work with a shell next to your files in their own working space. Their work merges into your drive, and every merge can be undone. When an agent reaches for sensitive material, you get a prompt like a two-factor sign-in.

**Status:** pre-alpha. Phase A (risk-elimination spikes) is starting. Nothing here is usable yet.

## Layout

| Path | What |
| --- | --- |
| `server/` | Drive service: store, reading, ring check, policy, sessions, merge, sandboxes, MCP, app API |
| `app/` | Phone-first web app |
| `cli/` | `drive put`, `drive watch`, `drive stats` |
| `sandbox/` | Session sandbox (gVisor) image: tools, `dsearch`, `dgrep`, `dmeta` |
| `test/` | Synthetic fixtures, invariant tests, leak suite, end-to-end tests |
| `spikes/` | Phase A experiments; throwaway |
| `docs/decisions/` | Decision records |

Test data is always synthetic. Real data lives outside the checkout.

MIT licensed; see [LICENSE](LICENSE).
