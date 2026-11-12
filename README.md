[README.md](https://github.com/user-attachments/files/34747117/README.md)
# Annual Leave Planner

A shared leave plan for your team. Everyone adds their own leave and sees, by month, who is off and for how many days. It runs on its own, with no dependencies and no Claude account needed.

- `server.js` is the web server and the shared storage (Node 18 or newer, built-in modules only).
- `index.html` is the page people open.
- Leave is saved in `data/leave.json`. Back up that one file and you have backed up everything.
- Open pages update live when anyone adds or removes leave.
- Every calendar day in a leave period is counted, weekends included.

## Run it on your computer

```
node server.js
```

Open http://localhost:3000. Other people on the same network can use `http://<your-computer-address>:3000`.

## Put it online for your team

The site needs a host that runs Node (or Docker) and keeps a small disk so the data survives restarts. Any of these work:

- **A small server or VPS:** copy the files, run `EDIT_CODE=your-code PORT=3000 node server.js` under `pm2` or `systemd`, and put it behind Nginx or Caddy for HTTPS.
- **Docker:** `docker build -t leave-planner .` then `docker run -d -p 3000:3000 -v leave-data:/data -e EDIT_CODE=your-code leave-planner`.
- **Render:** see the section below. This project includes a `render.yaml` that sets everything up.
- **Railway, Fly.io and similar:** create a web service from these files, start command `node server.js`, attach a persistent disk, and set `DATA_DIR` to the disk's mount path. Without a disk the plan resets on every redeploy.

## Deploy on Render

1. Put these files in a GitHub, GitLab or Bitbucket repository (the files from the zip, at the top level of the repo).
2. In the Render dashboard choose **New**, then **Blueprint**, and select the repository.
3. Render reads `render.yaml` and asks for `EDIT_CODE`. Enter the team code you want people to use to add leave.
4. Click **Apply**. When the deploy finishes, Render gives you a URL ending in `onrender.com`. Share that with your team.

The blueprint uses a paid **Starter** web service because Render only attaches a persistent disk (which keeps `leave.json` safe across restarts and redeploys) to paid services. The free plan has no disk, so the plan would be wiped on every restart or redeploy. Check Render's pricing page for the current price. A service with a disk runs as one instance and has a few seconds of downtime on each deploy, which is fine for this site.

Always serve it over HTTPS if it is on the public internet.

## Settings

| Variable | What it does |
| --- | --- |
| `PORT` | Port to listen on. Default 3000. |
| `DATA_DIR` | Folder for `leave.json`. Default `./data`. |
| `EDIT_CODE` | A team code. When set, anyone with the link can view, but adding or removing leave needs the code. When not set, anyone with the link can edit. |
| `TRUST_PROXY` | Set to `1` behind a reverse proxy so the rate limit sees each person's address. |

## Things to know

- Without `EDIT_CODE`, anyone who finds the link can add or delete leave, so set one for a public site.
- Anyone who can view the page can see every name and date. There are no individual accounts, and anyone with the code can remove anyone's entry.
- Each address is limited to 60 changes per minute.
- The plan holds up to 5,000 entries.
