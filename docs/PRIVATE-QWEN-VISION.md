# GPT only or GPT + my GPU

ComputerUse account settings now let each owner choose how screen observations reach their GPT planner. The default for accounts without a configured GPU is **GPT only**. This setting does not change the GPT model, funding source or human live-view stream.

- **GPT only:** screenshot tools provide an image to GPT, using the connected subscription or API allowance.
- **GPT + my GPU:** Qwen3-VL reads the screenshot on the selected account computer. GPT receives a focused text observation, limited to 260 local output tokens / 1,600 characters. GPT continues to plan and choose authorized computer actions. No raw image accompanies the local tool result. Screen text and local answers remain untrusted observations.

GPU failures pause observation with an actionable error. There is no automatic cloud fallback. The owner can explicitly switch to GPT only at any time; the next observation uses that mode. Screenshots already submitted before a switch cannot be recalled from an existing conversation. GPT still consumes text/reasoning usage, and total allowance savings depend on task length, retries and conversation history.

## Connect your GPU

1. Open **Account settings → ComputerUse → How AI reads your computer** and choose **GPT + my GPU**.
2. Choose an account computer or use **Connect a GPU computer**. For a private computer, connect Tailscale first. The guided SSH setup generates a dedicated key, provides the public-key installation command and asks you to verify the host fingerprint. Enable Work agent access. New guided account connections are owner-only until you change their sharing.
3. Select **Detect GPU & models**. Boardly reads GPU memory, operating system, available disk space, runtime, model files and service status without downloading or loading a model. If files are missing, select **Install missing vision models**. Setup requires Linux x86_64, Python 3.11+, curl, a user systemd session, Vulkan drivers and at least 12 GB of GPU memory; 16 GB is recommended. The installer selects the largest compatible Vulkan card. Native Windows/macOS installation is not included. Detection must be less than 30 minutes old and match the current SSH connection before installation is allowed. Model file sizes establish whether a download appears necessary; setup verifies SHA-256 digests, and the inference test confirms working vision.
4. After installation finishes, select **Test GPU**. Boardly sends a synthetic image through the authenticated connection and verifies that Qwen reads its heading. Save the mode only after the test passes.
5. Keep the GPU computer online. The service starts with the user's systemd session. For operation without an interactive login, enable lingering on that machine: `loginctl enable-linger "$USER"` (subject to that machine's permissions).

Connections, detections, successful tests and selected modes belong to the authenticated account workspace. New account owners default to GPT only and must connect and test their own GPU to enable local vision. A different account cannot select your connection ID or use a platform fallback GPU.

Enable **Let company members use my GPU for vision** to share inference with company members who have project edit access and the existing **Computer use** permission. Project-only guests are excluded. Sharing starts disabled for other accounts and existing installations; the owner can enable or revoke it in vision settings. Members use the company GPU automatically in permitted company Work tasks. They cannot manage the GPU installation or change the owner's mode. Sharing delegates only the fixed loopback vision request through the owner's connection; it does not change the SSH profile, reveal its key or grant shell/desktop access to the GPU machine. Membership, company, Computer use scope, sharing and SSH connection revocation are rechecked during inference. Human takeover and project desktop leases remain enforced, including lease renewal during longer inference.

## Runtime and memory sharing

The installer verifies SHA-256 digests for official Qwen3-VL-8B-Instruct Q4_K_M weights, the F16 vision projector and llama.cpp b10930's portable Vulkan runtime. Exact model revision and digests are in `scripts/qwen-vision/install.py`. Downloads and runtime live under `~/.local/share/boardly-vision`; the service is `boardly-vision.service` in the user systemd manager.

The screenshot reader listens only on loopback port 18765. Boardly reaches that fixed service over the selected account's encrypted, pinned SSH connection, including Tailscale and jump hosts. The model server uses loopback port 18766. No public model port, shared platform GPU pool, image log or persistent screenshot file is created by this connector.

One screen inference runs at a time. The reader checks ComfyUI's local port 8188, refuses work while its queue is active, requests release of idle image-model caches before loading Qwen, and terminates only its own model process when image work arrives. Qwen releases its model after 30 idle seconds. Other GPU applications are not centrally scheduled; insufficient memory returns an error. Never expose these loopback services using an unauthenticated public proxy.

Use `systemctl --user status boardly-vision` to check the service, or `systemctl --user stop boardly-vision` to stop it. Installation progress is in `install-status.json`; the install log contains download/runtime setup diagnostics, not screenshots. Selecting GPT only leaves the installation available for the next switch and idle memory is released automatically.

## Verification on an RTX 5060 Ti, 2026-09-12

On the tested 16 GB card, runtime GPU memory was approximately 7,072 MiB. A 1280×800 synthetic invoice screen produced correct amount/status/error text in 7.41 seconds including loading; two subsequent focused answers took 1.68 and 0.94 seconds. The answers contained 35, 18 and 8 local completion tokens. Button coordinates landed inside the requested target; the model correctly reported an absent button. The initial first-run tiny-screen inference took 33.96 seconds, so warm latency is not a cold-start guarantee. A separate browser interaction used Qwen’s predicted button position to click Save draft and then used a second Qwen observation to verify “Saved successfully”.

A sharing test loaded Qwen, submitted a local ComfyUI image job, verified that Qwen unloaded and rejected new inspection as busy, and observed the image job complete successfully in 115.96 seconds. Afterward Qwen read the test heading again in 14.70 seconds. This is verification of this machine and workload, not a guarantee for all GPUs or image models.

Automated checks cover HTTP over real pinned SSH and a jump host, hosted GPT payloads without screenshot attachments, the native helper returning text without an image file, reversible mode selection, offline behavior, in-flight mode/permission changes, human takeover and cross-account rejection. Browser checks cover installation progress, testing before enablement, persistence after reload, both mode choices and mobile layout. Existing desktop, viewer, worker and SSH regression checks remain applicable.

This removes GPT image input from new ComputerUse observations in local mode. It does not establish a measured percentage reduction in whole-task GPT usage or a guarantee of accuracy on arbitrary websites. Verify important actions and ask focused follow-up questions when observations are uncertain.

## Deployment compatibility

The native helper's `inspect({desktop_id,question})` uses the existing screenshot broker command. Update the helper before enabling local mode; the matching worker image also contains the updated planner instructions. On an immutable worker, roll out the worker image using the existing graceful restart and saved-session recovery, and verify the same task/conversation resumes before enablement. On a writable development worker, the compatible helper can be updated without interrupting active work. Existing workers learn the current mode and focused-question behavior from computer listing and observation results.
