# Middagsplan

A small web app for planning family dinners: your own recipes, a week plan with a
cook assigned to each day, pantry staples, and a shopping list that can be sent to
an Oda cart. The interface is in Norwegian (bokmål).

## What it does

- **Uke** (week): pick a dinner for each day and who cooks it. Today's dinner is shown on
  top with the time cooking has to start. The dice picks a recipe you haven't had
  for a while.
- **Oppskrifter** (recipes): name, prep and cooking time, ingredients with amounts, instructions.
- **Basisvarer** (pantry staples): staples you normally always have. Tap "Tomt" and the item lands on
  the shopping list.
- **Handleliste** (shopping list): the ingredients for the coming days' dinners, added up across
  recipes. Ingredients that are pantry staples in stock are listed separately. Tick
  off what you have, add anything else, and press "Ferdig handlet" when it is bought.
- **Oda**: connect an Oda account under Innstillinger. "Fyll Oda-handlekurven" then looks up
  each item at Oda, lets you choose the product, and adds them to the cart. The app
  remembers the product chosen for each ingredient. Payment and delivery time are
  always done at oda.com; the app cannot order anything.
- **Hent oppskrift fra nettet** (in "Ny oppskrift"): search for a dish, for example "adobo",
  in Spoonacular's recipe database. The chosen recipe is scaled to the servings in the
  form, translated to Norwegian by Claude Haiku (units converted to dl, ss, g and so on,
  ingredient names matched to the ones you already use) and filled into the form. Nothing
  is saved until you press "Lagre oppskrift". Needs the two API keys below.
- **Google Kalender**: each dinner is put in the Google Calendar of whoever cooks it, from
  the start-cooking time to dinner time, and kept up to date when the plan, the recipe,
  the cook or the dinner time changes. A day with no cook gets no event, and events for
  past days are left alone. If Google cannot be reached the plan is still saved; the day
  shows a warning with "Prøv igjen", and Innstillinger has "Synk alle kommende middager".
  The app only touches events it created itself.

An ingredient counts as a pantry staple when its name is the same as the staple's
name (upper and lower case do not matter).

## Run locally

```bash
python -m venv .venv
.venv/Scripts/python -m pip install -r requirements.txt
.venv/Scripts/python -m uvicorn app.main:app --port 8123
```

Then open http://localhost:8123. Data is stored in `data/mealprep.db`.

## Configuration

| Variable       | What it is                                                              |
| -------------- | ----------------------------------------------------------------------- |
| `APP_PASSWORD` | Household password. If empty, the app is open to anyone who can reach it. |
| `DATA_DIR`     | Folder for the database. `/data` in the container.                      |
| `TZ`           | Time zone used to decide what "today" is. Defaults to `Europe/Oslo`.    |
| `SPOONACULAR_API_KEY` | Optional. Free key from spoonacular.com/food-api, for the recipe search. The free plan has a daily limit. |
| `ANTHROPIC_API_KEY`   | Optional. Key from console.anthropic.com, used to translate fetched recipes (Claude Haiku, well under 1 øre per recipe). |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Optional. The whole JSON key of a Google service account, for Google Calendar. `GOOGLE_SERVICE_ACCOUNT_FILE` (a path to the key file) works too. |

### Google Calendar setup (one time)

1. In [Google Cloud Console](https://console.cloud.google.com/), create a project and enable
   the **Google Calendar API**.
2. Under *IAM & Admin → Service accounts*, create a service account (no roles needed),
   open it, *Keys → Add key → JSON*, and download the key.
3. Put the whole content of the key file in the stack variable `GOOGLE_SERVICE_ACCOUNT_JSON`
   and redeploy. Never commit the key.
4. Each cook opens Google Calendar → *Settings* → their calendar → *Share with specific
   people*, adds the service account's email (shown in Innstillinger in the app, ends in
   `iam.gserviceaccount.com`) with **Make changes to events**.
5. In the app, Innstillinger → Google Kalender: enter each cook's calendar ID (for a main
   calendar it is the Gmail address; otherwise see *Integrate calendar* in the calendar's
   settings), and tick "Legg middagene inn i Google Kalender".

The service account can read and change everything on a calendar shared with it, but the
app only ever changes the dinner events it created.

## Deployment

Portainer stack from this repository, compose path `docker-compose.yml`.
Set these stack environment variables: `APP_PASSWORD` (the household password; the
app stores an Oda sign-in, so do not leave it empty on a public address), and
`SPOONACULAR_API_KEY` and `ANTHROPIC_API_KEY` to turn on the recipe search, and
`GOOGLE_SERVICE_ACCOUNT_JSON` for Google Calendar.

The container `mealprep` has no host port. It joins the external Docker network `proxy`
and serves plain HTTP on port 8080. Point Traefik at `http://mealprep:8080`; Traefik
terminates HTTPS.

The database is kept in `/opt/mealprep` on the host. Back up that folder to keep
your recipes.

To update, use **Pull and redeploy** on the stack.

Connect Oda from the address you actually use the app on: the sign-in returns to
that address, so a connection made on `localhost` does not carry over.
