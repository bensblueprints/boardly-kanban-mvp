# Company setup and connections

On Companies home, choose **Quick Add Company** or **Chat to Build a Company**.

Quick Add needs a company name. Website and description are optional. You can open **Plan my next steps** from the company home whenever you want help planning.

Chat asks one question at a time. It can help find an idea, define customers and an offer, choose a working name and plan the first month of marketing. Responses depend on the AI and information you provide. Suggested prices and unverified demand remain assumptions to validate. The conversation and company brief are saved in your account, including your submitted answer if you need to connect AI first. Resume a draft from Companies home. Planning for an existing company resumes from **Plan my next steps**.

Use **Review & edit** to change the company brief, project names and task details. Remove any projects or tasks you do not want. **Save brief & keep chatting** saves the draft. **Create Company & Plan** creates the reviewed company and a Launch board with its projects. Tasks start in To Do. Existing-company plans update that company and add the reviewed Launch board. Each submitted creation request can create its plan only once. Created plans remain as records; start a new plan from company home for later work.

Marketing copy is a draft. Planning does not register a business, publish content, connect accounts or spend money.

## Free and paid companies

Basic Free includes one company and one user. Paid workspace plans include unlimited companies: Serial Entrepreneur includes five users; Agency includes 300. Extra-user billing and existing storage allowances remain as listed in Billing & user seats. Drafts do not consume a company allowance. Shared access belongs to the company owner's workspace. A downgrade preserves existing data but prevents adding companies above the free limit.

## Choose your AI

Go to **Settings → AI & models**.

- **Sign in with your account:** ChatGPT / Codex is Boardly's current OAuth option. Copy the device code, sign in on OpenAI's page, approve it and return. Codex access and limits come from your ChatGPT plan.
- **Connect with an API key:** Choose OpenAI, Claude or Kimi. Paste a key from that provider's API account. Choose a model and save or activate it. API billing is separate from a chat subscription. Claude and Kimi model lists are loaded from your account after verification; OpenAI shows Boardly's supported catalog.
- **Local AI:** Connect the model computer through Tailscale, select its port and verify the models it serves.

The owner chooses AI for companies they own. Members use that connection for shared work without receiving its credentials. Installed agents on ComputerUse desktops still need separate Boardly MCP access; external MCP remains restricted to the platform owner in this release.

## Discord and Telegram bots

Open **Settings → Connectors**, choose a bot and choose its company. The guided form explains each step and checks the bot's identity before saving its encrypted token.

Discord: open the [developer portal](https://discord.com/developers/applications), create an application, open Bot and generate a bot token. Paste it in Boardly. Use the generated invite to add the bot to your server with View Channels and Send Messages. Choose your server and text channel from Boardly's lists. Click **Send test message**. See [Discord's official bot guide](https://docs.discord.com/developers/quick-start/getting-started).

Telegram: open [BotFather](https://t.me/BotFather), send `/newbot`, and answer its name and username questions. Paste its token in Boardly. Use a new bot dedicated to Boardly. Click **Get my bot link**, open it in Telegram and press Start. Return and click **Check my chat**, then send a test. This pairs a private Telegram chat without copying a numeric chat ID. See [Telegram's official BotFather guide](https://core.telegram.org/bots/features#botfather).

Once connected, choose a company project, preview its task-count update and click **Send this update**. Messages are sent only by an explicit owner action. This release does not process inbound bot commands, run AI chats in messaging apps or schedule automatic notifications. A bot token alone does not configure those behaviors. Discord may show the bot offline because this connection sends through its HTTP API rather than maintaining a presence session.

Tokens are private to the company owner and never returned in status or included in project prompts. Test messages do not contain project data. Project updates contain only the chosen project name and task counts. Discord mentions are disabled. A timed-out send is marked unconfirmed and is never automatically repeated. Disconnect removes Boardly's stored token; delete or revoke the bot in its provider if you want to remove it there too.

## Help for every connector

Each existing connector has **Walk me through it, step by step**, including how to check success and what to do if it gets stuck. **Settings → Connectors → Download step-by-step connection guide** saves a Markdown guide for AI, GitHub, ComputerUse, SSH, Tailscale, 1Password, email, project secrets, purchase cards, fal, Higgsfield, MCP and the two bots.

## Verification and limits

Cloud fixtures cover tenant/member isolation, encrypted bot tokens, missing AI, malformed AI replies, optimistic draft edits, idempotent creation and sends, paid/free entitlements, Discord channel choice and Telegram private pairing. Browser fixtures cover company setup, review and task edits, returning from AI settings, bot setup and a narrow screen. Real customer provider or bot credentials are verified when entered; the release tests do not charge real providers or message real channels.
