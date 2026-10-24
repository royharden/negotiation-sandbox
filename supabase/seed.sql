-- Synthetic catalog. Load with a role that bypasses row level security.
-- The app also bundles fixtures/ and does not depend on this file to run scripted games.
-- Re-running is safe: the public slug index ignores an existing catalog row.

insert into public.scenarios (owner_id, slug, title, document, visibility)
values (
  null,
  'warehouse-lease',
  'Warehouse lease',
  $warehouse${
  "schemaVersion": 1,
  "id": "warehouse-lease",
  "title": "Warehouse lease",
  "publicBrief": "A buyer and a seller negotiate a short commercial lease. Issue bounds are public. Each side's scores and reservation stay private.",
  "issues": [
    {"id": "rent", "label": "Monthly rent", "kind": "number", "min": 4000, "max": 8000, "step": 100, "unit": "USD"},
    {"id": "term", "label": "Term in months", "kind": "choice", "options": ["12", "24", "36"]},
    {"id": "deposit", "label": "Deposit months", "kind": "number", "min": 0, "max": 3, "step": 1}
  ],
  "parties": {
    "buyer": {
      "publicBrief": "You need usable space this quarter and would rather not tie up cash in a deposit.",
      "private": {
        "reservationUtility": 42,
        "scores": {
          "rent": {"kind": "number", "atMin": 50, "atMax": 0},
          "term": {"kind": "choice", "options": {"12": 8, "24": 22, "36": 14}},
          "deposit": {"kind": "number", "atMin": 15, "atMax": 0}
        }
      }
    },
    "seller": {
      "publicBrief": "You would rather sign a lease than keep the building vacant.",
      "private": {
        "reservationUtility": 37,
        "scores": {
          "rent": {"kind": "number", "atMin": 0, "atMax": 50},
          "term": {"kind": "choice", "options": {"12": 6, "24": 16, "36": 28}},
          "deposit": {"kind": "number", "atMin": 0, "atMax": 15}
        }
      }
    }
  },
  "rules": {"maxRounds": 6, "openingRole": "buyer", "disagreementUtility": 0}
}$warehouse$::jsonb,
  'public'
)
on conflict (slug) where owner_id is null do nothing;

insert into public.scenarios (owner_id, slug, title, document, visibility)
values (
  null,
  'design-retainer',
  'Design retainer',
  $retainer${
  "schemaVersion": 1,
  "id": "design-retainer",
  "title": "Design retainer",
  "publicBrief": "A client and a studio set a monthly retainer and who keeps the working files.",
  "issues": [
    {"id": "fee", "label": "Monthly fee", "kind": "number", "min": 2000, "max": 6000, "step": 250, "unit": "USD"},
    {"id": "files", "label": "Working files", "kind": "choice", "options": ["client", "shared", "studio"]}
  ],
  "parties": {
    "buyer": {
      "publicBrief": "You want predictable design capacity without buying the studio archive.",
      "private": {
        "reservationUtility": 18,
        "scores": {
          "fee": {"kind": "number", "atMin": 40, "atMax": 0},
          "files": {"kind": "choice", "options": {"client": 12, "shared": 9, "studio": 0}}
        }
      }
    },
    "seller": {
      "publicBrief": "You want a retainer that covers senior time.",
      "private": {
        "reservationUtility": 16,
        "scores": {
          "fee": {"kind": "number", "atMin": 0, "atMax": 40},
          "files": {"kind": "choice", "options": {"client": 0, "shared": 7, "studio": 14}}
        }
      }
    }
  },
  "rules": {"maxRounds": 6, "openingRole": "buyer", "disagreementUtility": 0}
}$retainer$::jsonb,
  'public'
)
on conflict (slug) where owner_id is null do nothing;
