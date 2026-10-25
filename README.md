# OpsNest Financial Intelligence System: put it online

This folder is the complete app: the website (`public/index.html`) and the server (`server.js`) that stores your data safely in a database.
You need three free accounts: **Neon** (database), **GitHub** (stores the code) and **Render** (runs the app). It takes about 30 minutes the first time.

---

## Part 1: Make the database (Neon)

1. Go to **neon.tech** and click **Sign up** (Google login is fine).
2. Click **Create project**. Name it `opsnest`. Pick the region closest to you (for Oman or India choose **Singapore** or **Mumbai/Frankfurt** if offered). Click **Create**.
3. On the project page click **Connect**. You will see a long link starting with `postgresql://`.
4. Click **Show password**, then **Copy** the whole link. Paste it into Notepad for now. This is your `DATABASE_URL`. Treat it like a password.

## Part 2: Put the code on GitHub

1. Go to **github.com** and sign up (free).
2. Click the **+** at the top right, then **New repository**. Name it `opsnest`. Choose **Private**. Click **Create repository**.
3. On the next page click **uploading an existing file**.
4. Unzip this folder on your computer. Open it, select **everything inside** (`public` folder, `server.js`, `package.json`, `schema.sql`, `README.md`, `.env.example`, `.gitignore`) and drag it onto the GitHub page.
5. Wait for the upload to finish, then click **Commit changes**.

## Part 3: Run it (Render)

1. Go to **render.com** and sign up with your GitHub account.
2. Click **New +**, then **Web Service**, then pick your `opsnest` repository and **Connect**.
3. Fill in the form:
   - **Name:** `opsnest` (this becomes part of your web address)
   - **Language / Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance type:** Free to try. For real daily use choose the paid Starter plan, because the free plan goes to sleep after 15 minutes without visitors and the first page load then takes about a minute.
4. Scroll to **Environment Variables** and add these one by one (Add Environment Variable):

   | Name | Value |
   |---|---|
   | `DATABASE_URL` | the link you copied from Neon |
   | `JWT_SECRET` | any long random text, 40 or more letters and numbers (a password generator is fine). Never share it. |
   | `REGION` | `OM` for Oman (OMR, 5% VAT) or `IN` for India (INR, GST) |
   | `COMPANY_NAME` | your company name |
   | `ADMIN_NAME` | your full name |
   | `ADMIN_USERNAME` | the username you will use to sign in, for example `admin` |
   | `ADMIN_PASSWORD` | a strong password, at least 8 characters |

5. Click **Create Web Service**. Wait 2 to 5 minutes until the top shows **Live**.
6. Click the address at the top (like `https://opsnest.onrender.com`). You will see the sign-in page. Sign in with your `ADMIN_USERNAME` and `ADMIN_PASSWORD`.

If the page says it cannot start, open **Logs** in Render. The last red line says what is wrong (usually a typo in an environment variable). Fix it under **Environment** and Render restarts by itself.

## Part 4: First setup inside the app

1. **Sites:** add each of your sites (Sites, then Add a site).
2. **Users:** add your clerks. Give each a username, a password of 8+ characters, a role and the sites they may use.
   - *Daily Ops Clerk*: enters daily expenses.
   - *Revenue & Payroll Clerk*: enters invoices and monthly payroll.
   - *Management*: sees everything and approves cancellations.
3. Send each person the web address, their username and password. Ask them to change the password under **Change Password**.

## Your own web address (optional)

In Render open your service, then **Settings**, then **Custom Domains**, and follow the steps. You need to own a domain (for example from Namecheap or GoDaddy).

## Good to know

- All data lives in Neon. In Neon you can see backups and history under the **Backup & Restore** area. For real company data, check Neon's current free-plan limits and consider a paid plan.
- Passwords are stored scrambled (bcrypt). Nobody, including you, can read them. Management can only create new passwords by adding a user or the person changing their own.
- A sign-in lasts 12 hours. Deactivating a user under **Users** blocks them immediately.
- To change the app later, edit the files on GitHub. Render redeploys automatically.
- To run it on your own computer instead: install Node.js, copy `.env.example` to `.env`, fill it in, run `npm install` then `npm start`, and open http://localhost:3000.
