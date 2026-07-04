# Installing the Seedance App (Beginner's Guide)

This guide assumes you've never used git, Node, or a terminal. Follow it top to
bottom and you'll be generating videos in about 10 minutes. Windows steps first;
Mac steps are at the bottom.

There are only four real steps:

1. Install Node.js (the thing that runs the app)
2. Download this project
3. Add your API key
4. Start the app

---

## Windows

### Step 1 — Install Node.js

Node.js is the program that runs this app. Installing it is like installing any
other program:

1. Go to <https://nodejs.org>
2. Click the big green **LTS** download button (LTS means the stable version)
3. Open the downloaded file and click **Next** through the installer. The
   default options are all fine — you don't need to change anything.

### Step 2 — Download this project

You do **not** need git. GitHub lets you download the project as a regular zip file:

1. On this project's GitHub page (where you're probably reading this), find the
   green **`<> Code`** button near the top right of the file list
2. Click it, then click **Download ZIP**
3. Open your **Downloads** folder, right-click the zip file, and choose
   **Extract All…** → **Extract**
4. You now have a normal folder containing the app. Move it wherever you like —
   your Documents folder is a fine home. Open the folder — you should see files
   like `server.js` and `README.md` inside. (If you only see another single
   folder, open that one — that's the real project folder.)

### Step 3 — Open a terminal in the project folder

The "terminal" is just a window where you type commands. You need it open **in
the project folder**:

1. Open the project folder in File Explorer (the one containing `server.js`)
2. Right-click on any **empty space** inside the folder (not on a file) and
   choose **Open in Terminal**

   *Don't see that option?* Click the **address bar** at the top of File
   Explorer (where the folder path is shown), type `cmd`, and press **Enter**.
   Either way a dark window opens — that's the terminal.

### Step 4 — Install the app's dependencies

In the terminal window, type this and press **Enter**:

```
npm install
```

This downloads the small libraries the app needs. It takes under a minute.
(If you get an error like `'npm' is not recognized`, Node.js didn't install
properly — close the terminal, reinstall Node from Step 1, then open a new
terminal and try again.)

### Step 5 — Add your API key

The app talks to kie.ai, which requires an account and an API key (the key is
like a password that also tracks your credit balance):

1. Go to <https://kie.ai/api-key>, create an account if needed, and copy your
   API key
2. Back in the terminal, type these two commands (press **Enter** after each):

   ```
   copy .env.example .env
   notepad .env
   ```

3. Notepad opens a small settings file. Replace `your_api_key_here` with the
   key you copied — the line should end up looking like:

   ```
   KIE_API_KEY=abc123yourrealkey
   ```

4. Save (Ctrl+S) and close Notepad.

> ⚠️ Your key is money — anyone who has it can spend your kie.ai credits.
> Don't share it or post screenshots of it.

### Step 6 — Start the app

In the terminal:

```
npm start
```

You'll see `Seedance app running: http://localhost:3000`. Open your web browser
and go to:

**<http://localhost:3000>**

That's it — you're running. 🎬

### Everyday use (after the first install)

- **To start the app:** open the terminal in the project folder (Step 3) and
  run `npm start`
- **To stop it:** click the terminal window and press **Ctrl+C** (or just close
  the terminal window)
- The terminal window must stay open while you use the app. Generated videos
  are saved in the `video` folder inside the project.

---

## Mac

Same four ideas, slightly different clicks:

1. **Install Node.js** — go to <https://nodejs.org>, download the **LTS**
   installer (.pkg), open it, and click Continue through the defaults.
2. **Download the project** — on the GitHub page, green **`<> Code`** button →
   **Download ZIP**. Double-click the zip in Downloads to extract it, and move
   the folder somewhere like Documents.
3. **Open Terminal in the folder** — open the **Terminal** app (press Cmd+Space,
   type `terminal`, press Enter). Type `cd ` (with a space after it), then
   **drag the project folder** from Finder onto the Terminal window — it fills
   in the path for you. Press **Enter**.
4. **Install and configure** — run these commands one at a time:

   ```
   npm install
   cp .env.example .env
   open -e .env
   ```

   TextEdit opens the settings file — replace `your_api_key_here` with your key
   from <https://kie.ai/api-key>, then save and close.
5. **Start it** — run `npm start`, then open <http://localhost:3000> in your
   browser. Stop it later with **Ctrl+C** in the Terminal.

---

## Troubleshooting

| Problem | Fix |
| --- | --- |
| `'npm' is not recognized` / `command not found: npm` | Node.js isn't installed (or the terminal was open during install). Reinstall from <https://nodejs.org>, then open a **new** terminal. |
| `Missing KIE_API_KEY` when starting | Step 5 didn't stick — make sure the file is named exactly `.env` (not `.env.txt`) and contains your real key. Redo the two commands in Step 5. |
| `EADDRINUSE: address already in use` | The app is already running in another window, or something else is using port 3000. Close other terminals, or edit `.env` and change `PORT=3000` to `PORT=3001` (then browse to localhost:3001). |
| Red "Server not reachable" banner in the browser | The terminal running `npm start` was closed. Start it again (Everyday use, above). |
| A generation fails with "Insufficient credits" | Your kie.ai account is out of credits — top up at <https://kie.ai>. |

## Updating to a newer version

Easiest zero-git method: download the ZIP again and extract it to a **new**
folder, then copy these items from your **old** folder into the new one so you
keep your key, media, and history:

- `.env`
- `history.json`, `images.json`, `projects.json` (whichever exist)
- the `video` and `images` folders

Then run `npm install` once in the new folder and `npm start` as usual.

## One last thing

This is free hobby software, provided **as is, with no warranty, at your own
risk** — see the [License & Disclaimer](README.md#license--disclaimer) in the
README. In short: you're responsible for your own computer, your kie.ai
credits and what they get spent on, whatever you create with the app, and
keeping your API key secret.
