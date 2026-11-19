# Middagsplan

Planlegg ukens middager for familien: egne oppskrifter, hvem som lager mat hvilken dag,
og en handleliste som kan sendes rett til Oda-handlekurven.

## Hva du får

- **Uke**: velg middag og kokk for hver dag.
- **Oppskrifter**: lagre egne, eller lim inn en oppskrift/lenke og la Claude fylle ut skjemaet.
- **Handleliste**: lages automatisk fra ukens middager, kan fylles i Oda-kurven.
- **Basisvarer**: trykk «Tomt», så havner varen på handlelisten.
- **Google Kalender** (valgfritt): middagen legges i kalenderen til den som lager mat.
- **Statistikk**: fisk per uke, vegetarandel, matgrupper m.m.

## Kom i gang

```bash
python -m venv .venv
.venv/Scripts/python -m pip install -r requirements.txt
.venv/Scripts/python -m uvicorn app.main:app --port 8123
```

Åpne http://localhost:8123. Data lagres i `data/mealprep.db`.

## Innstillinger (miljøvariabler)

| Variabel                      | Hva                                                         |
| ----------------------------- | ----------------------------------------------------------- |
| `APP_PASSWORD`                | Passord for appen. Sett alltid dette på en offentlig adresse. |
| `ANTHROPIC_API_KEY`           | Valgfri. Trengs for innliming av oppskrifter og statistikk.  |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Valgfri. Hele JSON-nøkkelen til en Google-tjenestekonto.    |

Oda kobles til under Innstillinger i appen – gjør det fra adressen du faktisk bruker.

## Google Kalender (valgfritt)

1. Lag en tjenestekonto i [Google Cloud Console](https://console.cloud.google.com/) med
   **Google Calendar API** på, og last ned en JSON-nøkkel.
2. Legg nøkkelen i `GOOGLE_SERVICE_ACCOUNT_JSON`.
3. Hver kokk deler kalenderen sin med tjenestekontoens e-post (vises i appen) med
   **Gjøre endringer i aktiviteter**.
4. I appen: Innstillinger → Google Kalender → legg inn kalender-ID per kokk.

## Drift

Portainer-stack fra dette repoet (`docker-compose.yml`). Containeren serverer HTTP på
port 8080 på Docker-nettverket `proxy`; pek Traefik på `http://mealprep:8080`.
Databasen ligger i `/opt/mealprep` på verten – ta backup av den. Oppdater med
**Pull and redeploy**.
