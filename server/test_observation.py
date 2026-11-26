"""L'observation signale un consommable épuisé, usagé ou contrefait."""

import unittest

import app as api


class ObservationTests(unittest.TestCase):
    def test_normalize_mentions_the_supply_to_replace(self):
        printer = api.normalize({
            "nom": "HP",
            "departement": "Urbanisme",
            "emplacement": "Bureau",
            "adresse": "10.0.0.8",
            "observation": "Bruit au démarrage",
            "cartouches": [{"marque": "HP", "type": "Toner noir", "value": 8}],
            "kits": [
                {"label": "Kit de fusion usagé", "level": 40},
                {"label": "Tambour contrefacon", "level": 10},
            ],
        })
        self.assertEqual(
            printer["observation"],
            "\n".join([
                "Bruit au démarrage",
                "HP Toner noir : épuisé, à remplacer par un neuf.",
                "Kit de fusion usagé : usagé.",
                "Tambour contrefacon : épuisé, à remplacer par un neuf.",
                "Tambour contrefacon : contrefaçon.",
            ]),
        )

    def test_a_recovered_level_drops_the_automatic_line(self):
        self.assertEqual(
            api.compose_observation("Toner noir : épuisé, à remplacer par un neuf.", [("Toner noir", 50)]),
            "RAS",
        )

    def test_eleven_percent_stays_quiet(self):
        self.assertEqual(api.compose_observation("RAS", [("Cyan", 11)]), "RAS")
