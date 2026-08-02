# Two-Mac MLX cluster

This guide configures two 48 GB MacBook Pros as one distributed MLX inference
cluster:

| Rank | Mac | User | Role |
|---|---|---|---|
| 0 | M5 Pro, 48 GB | `dustinmays` | Controller, `mlx_lm.server`, T3, OpenCode |
| 1 | M4 Pro, 48 GB | `dustin` | MLX worker |

The normal request path is:

```text
T3 -> OpenCode -> http://127.0.0.1:8080/v1
                         |
                  mlx_lm.server rank 0 (M5)
                         |
                  Thunderbolt 5 / JACCL
                         |
                       rank 1 (M4)
```

MLX shards a supported model between the machines. It does not expose a general
96 GB shared-memory device. Both machines must remain connected and awake for
the lifetime of the server, and both must have the complete model on disk.

## Design choices

- **mise** pins Python 3.13.14 and supplies short, identical management tasks.
- **JACCL** provides low-latency RDMA over Thunderbolt 5 and is the primary
  backend. TCP ring over Thunderbolt is the fallback.
- **The M5 is always rank 0.** Only rank 0 opens the HTTP port.
- **Machine-specific values are not committed.** They live in the gitignored
  `cluster/config.local.env`.
- **A stable path exists on both Macs.** `/Users/Shared/local-llm` points to
  each user's clone, avoiding the different home-directory names.
- **A dedicated SSH key is used.** It has no passphrase and is authorized only
  on the M4 account. Normal personal SSH keys are not changed.
- **LM Studio remains available for single-Mac use.** Cluster startup unloads
  LM Studio on both machines so its model does not consume cluster memory.

## Requirements

- macOS 26.2 or later on both Macs; the current target is 26.6.
- A certified Thunderbolt 5 cable directly connecting the Macs.
- Both Macs plugged into power with their lids open.
- Wi-Fi or Ethernet active for SSH control traffic.
- Remote Login enabled on the M4 for user `dustin`.
- Homebrew, Git, and mise installed on both machines.
- The same Hugging Face MLX model repositories cached on both machines.

The shared model profiles are configured in tracked `cluster/models.env`:

```text
CLUSTER_MODEL_FAST="mlx-community/Qwen3.5-35B-A3B-4bit"
CLUSTER_MODEL_OVERNIGHT="mlx-community/Qwen3.5-122B-A10B-4bit"
CLUSTER_MODEL_TEST="mlx-community/Llama-3.2-3B-Instruct-4bit"
```

The fast and overnight models use MLX's shardable `qwen3_5_moe`
implementation and tool-aware chat templates. The test profile remains a
small, inexpensive end-to-end infrastructure diagnostic.

> **Compatibility note:** `Qwen3-Coder-30B-A3B-Instruct` uses MLX's
> `qwen3_moe` implementation. In `mlx-lm` 0.31.3 that implementation supports
> neither tensor nor pipeline sharding, so it remains a single-Mac LM Studio
> model. The cluster uses `Llama-3.2-3B-Instruct-4bit` for its inexpensive
> infrastructure validation and shardable Qwen3.5 profiles for production.

LM Studio, Ollama, and Hugging Face use different model storage layouts. A
model visible in another application is not necessarily available to
`mlx_lm`. The cluster check verifies the Hugging Face cache used by `mlx_lm`.

## One-time setup

### 1. Enable Remote Login on the M4

On the M4, open **System Settings > General > Sharing**, open the details for
**Remote Login**, and enable it for **Only these users: dustin**.

Do not enable "Allow full disk access for remote users"; MLX does not need it.

From the M5, verify the password-based connection:

```bash
ssh dustin@Dustins-MacBook-Pro.local
```

Exit the remote shell after it succeeds.

### 2. Install the repository on the M5

If this is the existing clone:

```bash
cd ~/repos/local-llm
git pull --ff-only
```

For a new clone:

```bash
mkdir -p ~/repos
git clone https://github.com/dustinmays/local-llm.git ~/repos/local-llm
cd ~/repos/local-llm
```

Trust the repository's mise configuration and install the pinned environment:

```bash
mise trust
mise install
mise run setup
```

This creates `/Users/Shared/local-llm` as a symlink to the current clone.

### 3. Create the controller configuration

On the M5:

```bash
mise run cluster:init
```

This creates `cluster/config.local.env` with the known M4 values. Review it if
hostnames, ports, models, or repository locations differ. It is intentionally
ignored by Git.

### 4. Install unattended SSH access

On the M5:

```bash
mise run cluster:ssh-setup
```

Enter the M4 login password once. The task creates:

- `~/.ssh/id_ed25519_local_llm_cluster`
- `~/.ssh/config.d/local-llm-cluster`
- the `mlx-m5` and `mlx-m4` SSH aliases
- an idempotent entry in the M4's `~/.ssh/authorized_keys`

Apple's topology utility connects to every listed rank through SSH, including
rank 0. The same dedicated public key is therefore authorized locally on the
M5 for the `mlx-m5` loopback alias.

Verify it manually if desired:

```bash
ssh -o BatchMode=yes mlx-m4 hostname
```

### 5. Install the repository and environment on the M4

GitHub credentials stored by macOS may not be available to a non-interactive
SSH session. Perform Git operations in the M4's interactive terminal instead.
On the M4:

```bash
mkdir -p ~/repos
git clone https://github.com/dustinmays/local-llm.git ~/repos/local-llm
```

If the clone already exists, update it instead:

```bash
git -C ~/repos/local-llm pull --ff-only
```

Then return to the M5 and run:

```bash
mise run cluster:worker-setup
```

This validates the existing repository at `/Users/dustin/repos/local-llm`,
installs the pinned mise environment, and creates the M4's
`/Users/Shared/local-llm` link. It deliberately performs no GitHub operations.

After the small-model cluster test passes, download each production profile
locally. Stop the active cluster on the M5 first:

```bash
mise run cluster:stop
```

Then run this sequence once in an interactive terminal on the M5 and once on
the M4:

```bash
git pull --ff-only
mise run model:remove-llama
mise run model:download-all
```

Cleanup shows the exact Llama cache directories and requires typing
`remove llama`; it refuses to proceed while a Llama server is active. Downloads
never use SSH. They run sequentially, resume Hugging Face cache data after an
interruption, and use `caffeinate` to keep that Mac awake. Each Mac must retain
a complete snapshot; only resident inference weights are sharded.

### 6. Enable Thunderbolt RDMA on both Macs

This is the only step that cannot be automated remotely. Perform it separately
on each Mac:

1. Shut down the Mac.
2. Hold the power button until startup options appear.
3. Choose **Options**, then enter Recovery.
4. Open **Utilities > Terminal**.
5. Run:

   ```bash
   rdma_ctl enable
   ```

6. Reboot normally.

With the Thunderbolt 5 cable connected, verify on each Mac:

```bash
ibv_devices
```

At least one `rdma_en...` device should appear. An empty table means RDMA is
not enabled, the cable is not recognized as Thunderbolt, or the Mac needs
another reboot.

### 7. Inspect and configure the topology

Keep Wi-Fi connected so SSH remains available. Connect the Thunderbolt 5 cable
directly between the Macs.

From the M5:

```bash
mise run cluster:topology
mise run cluster:check
mise run cluster:configure
```

`cluster:topology` is read-only. `cluster:configure` invokes Apple's
`mlx.distributed_config` without passwordless sudo. If MLX prints interface
commands that require `sudo`, run the command shown for each host in a local
terminal on that host, then rerun `mise run cluster:configure`.

Successful configuration writes the gitignored hostfile:

```text
cluster/generated/hosts-jaccl.json
```

Do not hand-edit the hostfile. Regenerate it after changing cables, ports,
network interfaces, hostname, or backend.

### 8. Prove distributed communication

Before loading a model:

```bash
mise run cluster:smoke
```

Expected output contains two ranks and an all-reduce total of three:

```text
rank=0 size=2 ... all_sum=3
rank=1 size=2 ... all_sum=3
```

Do not proceed if only one rank appears or the command hangs.

Download and start the small known-shardable server test:

```bash
mise run model:download-test  # run once on each Mac
mise run cluster:start-test
mise run cluster:test
mise run cluster:stop
```

Startup does not treat the model-list endpoint as proof of health. It sends a
real chat completion and reports readiness only after sharded loading and token
generation succeed.

### 9. Install the OpenCode configuration

On the M5:

```bash
mise run opencode:install
```

The task creates a timestamped backup before installing the repository's
configuration. It preserves both providers:

- `lmstudio` at `http://127.0.0.1:1234/v1`
- `mlxcluster` at `http://127.0.0.1:8080/v1`

In T3's OpenCode provider settings:

- **Binary path:** `/opt/homebrew/bin/opencode`
- **Server URL:** leave blank
- **Server password:** leave blank

T3's Server URL is for `opencode serve`, not the MLX model endpoint. OpenCode
reads its own configuration and talks to the cluster endpoint.

Restart T3 after installing the configuration. In a new OpenCode thread,
choose **MLX Cluster (M5 + M4)** and the model matching the running server.
The installer renders fast, overnight, and test entries from
`cluster/models.env`; no model ID needs to be duplicated in the OpenCode
template.

## Daily operation

Run all management commands from the M5 repository.

Start the fast interactive model:

```bash
mise run cluster:check
mise run cluster:start-fast
```

Start the overnight model instead:

```bash
mise run cluster:check-overnight
mise run cluster:start-overnight
```

Startup performs these actions:

1. Refuses to start if a managed cluster or API is already running.
2. Unloads and stops LM Studio on both Macs.
3. Starts one MLX rank per Mac through `mlx.launch`.
4. Keeps both machines awake with `caffeinate` while ranks exist.
5. Sends a real completion and waits for loading and generation to succeed.
6. Records the controller launcher PID, active model, and log under
   `cluster/run/`.

Inspect status and make a small API request:

```bash
mise run cluster:status
mise run cluster:test
mise run cluster:test-tools
mise run cluster:benchmark
```

Follow logs:

```bash
mise run cluster:logs
```

Stop both ranks cleanly:

```bash
mise run cluster:stop
```

Always stop the cluster before disconnecting the cable, closing a lid, changing
networks, rebooting a Mac, or starting LM Studio again.

## Common workflows

### Return to single-Mac LM Studio

```bash
mise run cluster:stop
llm-serve
```

OpenCode model:

```text
lmstudio/qwen3-coder-30b-a3b-instruct@4bit
```

### Return to the cluster

```bash
llm-serve-stop
mise run cluster:start-fast
```

OpenCode model:

```text
mlxcluster/mlx-community/Qwen3.5-35B-A3B-4bit
```

### Update both machines

Commit and push controller changes first. Update the controller on the M5:

```bash
git pull --ff-only
mise run setup
```

Update the worker from the M4's interactive terminal:

```bash
git -C ~/repos/local-llm pull --ff-only
```

Then, back on the M5:

```bash
mise run cluster:worker-setup
mise run cluster:check
```

### Select ring-over-Thunderbolt temporarily

Edit the controller's `cluster/config.local.env`:

```bash
CLUSTER_BACKEND="ring"
CLUSTER_TRANSPORT="thunderbolt"
```

Then regenerate and test:

```bash
mise run cluster:configure
mise run cluster:smoke
```

Ring uses TCP over the Thunderbolt interfaces. It avoids RDMA requirements but
has higher latency; JACCL is preferred for tensor-parallel inference.

## Troubleshooting

### SSH still asks for a password

```bash
ssh -vv mlx-m4 true
```

Confirm the final output authenticates with
`id_ed25519_local_llm_cluster`. Then rerun:

```bash
mise run cluster:ssh-setup
```

### `/Users/Shared/local-llm` is wrong

The setup task will not overwrite it. Inspect it:

```bash
ls -ld /Users/Shared/local-llm
```

If it is an obsolete symlink, remove only that symlink and rerun `mise run
setup`. Do not recursively remove `/Users/Shared` or either repository clone.

### `ibv_devices` is empty

- Confirm both Macs run macOS 26.2 or later.
- Confirm `rdma_ctl enable` was run in Recovery on that Mac.
- Reboot after enabling RDMA.
- Use a certified Thunderbolt 5 cable rather than a charge-only USB-C cable.
- Connect the cable directly, without a dock.

### Configuration loses SSH midway

Thunderbolt interface setup can disable Thunderbolt Bridge. SSH control should
use Wi-Fi, so keep Wi-Fi enabled and ensure `mlx-m4` resolves to the M4's Wi-Fi
address.

### Server exits during model load

```bash
tail -n 200 cluster/run/server.log
mise run cluster:check
```

The usual causes are a missing model snapshot on one node, different MLX
versions, a stale hostfile, LM Studio still holding memory, or a broken RDMA
link.

### T3 cannot connect

First isolate the layers:

```bash
mise run cluster:status
mise run cluster:test
opencode models mlxcluster
```

If the API test succeeds but T3 fails, leave T3's OpenCode **Server URL** blank
and restart T3. If the API test fails, diagnose the cluster before OpenCode.

### Emergency cleanup after a crashed controller

First try the normal command:

```bash
mise run cluster:stop
```

If its PID file is stale, inspect processes on each machine before terminating
anything:

```bash
ps aux | grep '[m]lx_lm server'
ssh mlx-m4 "ps aux | grep '[m]lx_lm server'"
```

Avoid broad `pkill python` commands; they can terminate unrelated work.

## Changing model profiles

Do this only after the small diagnostic model passes `cluster:smoke` and
`cluster:test`.

Model weights must leave headroom on each rank for macOS, runtime allocations,
and prompt cache. A model fitting on disk does not prove it will load safely.

For a new model:

1. Choose an MLX repository whose architecture supports distributed sharding.
2. Download the identical repository revision on both Macs.
3. Confirm the complete model exists in both Hugging Face caches.
4. Change the appropriate variable in `cluster/models.env` and pull the same
   commit on both Macs.
5. Run `mise run opencode:install` to render the new model into OpenCode.
6. Restart T3 and the cluster.
7. Run `cluster:test`, `cluster:test-tools`, and `cluster:benchmark` before
   unattended use.

## Security and recovery notes

- The cluster HTTP server binds only to `127.0.0.1` on the M5.
- Remote Login is limited to the M4 user selected in macOS Sharing settings.
- No script configures passwordless sudo.
- The dedicated SSH key can be revoked by removing its line containing
  `local-llm-cluster` from the M4's `~/.ssh/authorized_keys` and deleting the
  matching key and SSH fragment on the M5.
- `mlx_lm.server` is intended as a local endpoint, not an Internet-facing
  production service.
- Machine-specific configuration, generated hostfiles, PIDs, and logs are
  excluded from Git.
