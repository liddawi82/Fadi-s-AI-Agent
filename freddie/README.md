# Freddie

A bilingual assistant with his own phone number. Message him on **WhatsApp or
SMS** — in Jordanian Arabic or American English, typed or as a voice note — and
he places the call, talks to a real person, and reports back.

He answers on whichever channel you used. Text him and he texts back; WhatsApp
him and he replies there, with a voice note if you sent one. Call reports go to
the channel you last messaged from, even if the call ends minutes later.

If something goes wrong on the call that only you can decide, he messages you
while still holding the line.

---

## What you need before you start

Five accounts. Two are free. **Nobody can open these for you** — each one needs
your identity, your card, and a code texted to your phone.

| # | Account | Cost | Notes |
|---|---|---|---|
| 1 | Meta Business | Free | **Start this first.** Verification can take weeks. |
| 2 | Twilio | Free trial, ~$20 later | Freddie's phone line and WhatsApp |
| 3 | OpenAI Platform | ~$5 to load | **Not** your ChatGPT subscription |
| 4 | Vapi | Free tier | Runs the actual phone conversation |
| 5 | Railway | ~$5/mo | Where Freddie lives |
| 6 | GitHub | Free | Only so Railway can see the code |

You do **not** need ElevenLabs — Vapi includes the voices. You do **not** need
Google Places unless you want Freddie looking up numbers for you.

---

## Part 1 — Meta, first, then forget about it

This is the only step with a queue, so it goes first. Everything else works
while you wait.

1. Go to **business.facebook.com** and create a Business Portfolio.
2. Open **Settings → Business Info → Verification** and start it.
3. Upload what it asks for. Then leave it alone — it takes days to weeks.

You don't need this finished to build Freddie. You need it finished before he
gets his own permanent number. Until then he borrows a shared test number, which
works exactly the same from your phone.

---

## Part 2 — The other accounts

### Twilio

1. Sign up at **twilio.com**. Verify your phone.
2. From the Console home page copy two values — you'll paste them later:
   - **Account SID** (starts with `AC`)
   - **Auth Token** (click to reveal)
3. Stay on the trial for now. You get 75 voice minutes and 100 WhatsApp
   messages free, which is plenty to test with.

### OpenAI Platform

1. Go to **platform.openai.com** — this is a different product from ChatGPT,
   with separate billing, even though you sign in with the same email.
2. **Settings → Billing** → add $5–10.
3. **API keys → Create new secret key.** Copy it now; it's shown once.

### Vapi

1. Sign up at **vapi.ai**.
2. **API Keys** → copy the **Private** key (not the public one).
3. Leave the tab open — you'll come back after Railway.

### GitHub

1. Sign up at **github.com**. That's it — you won't write any code.

---

## Part 3 — Put Freddie on the internet

1. Unzip the Freddie folder somewhere you can find it.
2. Go to **github.com/new**, name the repository `freddie`, keep it
   **Private**, click **Create**.
3. On the next page click **uploading an existing file**, then drag in
   everything from the Freddie folder. Click **Commit changes**.
4. Go to **railway.app** and sign in with GitHub.
5. **New Project → Deploy from GitHub repo → freddie**.
6. It will start building and fail. That's expected — it has no settings yet.

### Give him his settings

In Railway, open your service and click the **Variables** tab. Add each of
these as a Name / Value pair. `.env.example` in the code folder lists them all
with explanations.

| Name | Value |
|---|---|
| `OWNER_WHATSAPP` | Your WhatsApp number, e.g. `+15551234567` |
| `OWNER_NAME` | `Fadi` |
| `TWILIO_ACCOUNT_SID` | From Twilio, starts with `AC` |
| `TWILIO_AUTH_TOKEN` | From Twilio |
| `TWILIO_WHATSAPP_FROM` | `+14155238886` (the shared test number, for now) |
| `OPENAI_API_KEY` | From OpenAI, starts with `sk-` |
| `VAPI_API_KEY` | Your Vapi **private** key |
| `VAPI_WEBHOOK_SECRET` | Make up a long random string |

Then **Settings → Networking → Generate Domain**. Copy the URL it gives you and
add one more variable:

| Name | Value |
|---|---|
| `PUBLIC_URL` | The Railway URL, no slash at the end |

Redeploy. Open `https://your-url/health` in a browser — you should see Freddie
reporting his own status.

### Give him a memory

**Variables → + New Volume**, mount path `/data`. Without this he forgets your
contacts every time you deploy a change.

---

## Part 4 — Wire the three pieces together

### Twilio → Freddie

Freddie accepts both channels at two paths that behave identically:

| Channel | Webhook URL |
|---|---|
| WhatsApp | `https://your-railway-url/whatsapp` |
| SMS | `https://your-railway-url/sms` |

**On a trial account** (Try out SMS / Try out WhatsApp pages): select
**Inbound**, set Auto-Reply settings to **Custom**, paste the URL, method
**POST**, Save. Do it on both pages to enable both channels.

**On an upgraded account**: Messaging → Settings → the sender's configuration,
in the **When a message comes in** field.

### Vapi → Freddie

1. Vapi dashboard → **Phone Numbers → Import from Twilio**. Paste your Twilio
   SID and token, and the number.
2. Copy the **phone number ID** it creates.
3. Back in Railway, add `VAPI_PHONE_NUMBER_ID` with that value. Redeploy.

While on the trial you can only call numbers you've verified in Twilio
(**Phone Numbers → Verified Caller IDs**). Add your own mobile so you can watch
Freddie call you.

---

## Part 5 — Say hello

1. On your phone, open your normal WhatsApp.
2. Message **+1 415 523 8886** with the join code shown on your Twilio sandbox
   page — something like `join amber-tiger`.
3. Now just talk to him:

> book a table for four at Zaytinya on Friday at 8, ask for a booth

> رنّ على رامي وشوف إذا بيقدر ييجي عالعشا يوم الجمعة

Send a voice note and he'll transcribe it, act on it, and reply with a voice
note back.

**The sandbox connection expires every 3 days** — just send the join code again.
This stops once he has his own number.

---

## Part 6 — When Meta clears

1. Twilio → **Phone Numbers → Buy a number**, pick a local US number with Voice
   and SMS.
2. **Messaging → WhatsApp senders → New sender.** Choose that number.
3. When it asks how to verify ownership, **choose SMS, not voice call.** The
   voice channel points at Vapi by then, and Freddie would answer his own
   verification call.
4. Set that number's messaging webhook to `https://your-railway-url/whatsapp`.
5. In Railway, change `TWILIO_WHATSAPP_FROM` to the new number. Redeploy.
6. Save him in your contacts. Message him like anyone else.

---

## If something isn't working

Open `https://your-railway-url/health` first. It tells you what he thinks his
own settings are.

| What you see | What it means |
|---|---|
| No reply at all | Webhook URL is wrong in Twilio, or you didn't send the join code |
| "Freddie can't start" in the logs | A variable is missing — the log names which one |
| He replies but won't call | `VAPI_PHONE_NUMBER_ID` or `PUBLIC_URL` is missing |
| Calls fail instantly | Still on the Twilio trial and the number isn't verified |
| He forgets your contacts | No volume mounted at `/data` |

Railway's **Deploy Logs** tab shows everything he's doing, live. It's the first
place to look.

---

## Changing how he behaves

| Variable | Does what |
|---|---|
| `REQUIRE_CONFIRMATION` | `false` lets him dial without asking you first |
| `MAX_CALLS_PER_DAY` | Hard ceiling. Default 15 |
| `VOICE_REPLIES` | `false` for text-only replies. WhatsApp only — SMS always gets text |
| `OPENAI_TTS_VOICE` | `onyx`, `alloy`, `echo`, `fable`, `nova`, `shimmer` |
| `ELEVENLABS_VOICE_ID` | The voice he uses on the phone |

His personality, his manners on a call, and the Jordanian dialect rules all
live in **`src/brain/prompts.js`**. It's written in plain English — you can edit
it without knowing how to code. Change the file on GitHub and Railway redeploys
by itself.

---

## What he will and won't do

Built-in limits that no instruction can override:

- Only **you** can give him instructions. Messages from any other number are ignored.
- He never dials emergency or crisis lines.
- He never says a card number, security code, or password out loud.
- He always opens a call by saying he's an assistant calling for you.
- Calls are not recorded — several US states require every party to consent.
- He stops at `MAX_CALLS_PER_DAY`, so a misread message can't become forty dials.

---

## Testing it yourself

```
npm install
node scripts/test.js     # 25 offline tests, no accounts needed
npm run check            # checks your real keys once they're set
```
