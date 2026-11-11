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

## Deployment

Portainer stack from this repository, compose path `docker-compose.yml`.
Set these stack environment variables: `APP_PASSWORD` (the household password; the
app stores an Oda sign-in, so do not leave it empty on a public address).

The container `mealprep` has no host port. It joins the external Docker network `proxy`
and serves plain HTTP on port 8080. Point Traefik at `http://mealprep:8080`; Traefik
terminates HTTPS.

The database is kept in `/opt/mealprep` on the host. Back up that folder to keep
your recipes.

To update, use **Pull and redeploy** on the stack.

Connect Oda from the address you actually use the app on: the sign-in returns to
that address, so a connection made on `localhost` does not carry over.
