import unittest

import app as api


class ScriptedCursor:
    def __init__(self, replies):
        self.replies = list(replies)
        self.calls = []
        self.current = None

    def execute(self, sql, params=None):
        self.calls.append((" ".join(sql.split()), params))
        self.current = self.replies.pop(0)

    def fetchone(self):
        return self.current

    def fetchall(self):
        return self.current


def printer_row():
    return {
        "id": "imp-abcd1234",
        "nom": "HP LaserJet",
        "departement": "Urbanisme",
        "emplacement": "Bureau 2",
        "adresse": "10.0.0.8",
        "couleur": 1,
        "fourniture": "",
        "releve": "",
        "observation": "RAS",
        "ecart": 0,
        "snmp_communaute": "lecteurs",
        "niveaux_le": None,
    }


class LoadOneTests(unittest.TestCase):
    def test_reads_only_the_requested_printer(self):
        cursor = ScriptedCursor([
            printer_row(),
            [{
                "cle": "noir",
                "libelle": "Noir",
                "marque": "HP",
                "genre": "Noir",
                "pourcentage": 40,
                "swatch": "red",
                "extra": 0,
            }],
            [{"libelle": "Fusion", "pourcentage": 20}],
        ])

        printer = api.load_one(cursor, "imp-abcd1234")

        self.assertEqual([params for _sql, params in cursor.calls], [
            ("imp-abcd1234",),
            ("imp-abcd1234",),
            ("imp-abcd1234",),
        ])
        self.assertIn("FROM imprimantes WHERE id = %s", cursor.calls[0][0])
        self.assertIn("FROM toners WHERE imprimante_id = %s", cursor.calls[1][0])
        self.assertIn("FROM kits WHERE imprimante_id = %s", cursor.calls[2][0])
        self.assertEqual(printer["noir"], 40)
        self.assertEqual(printer["kits"], [{"label": "Fusion", "level": 20}])
        self.assertEqual(printer["snmpCommunaute"], "lecteurs")
        self.assertIsNone(printer["extra"])
        self.assertEqual(printer["cartouches"][0]["swatch"], "#5b4636")

    def test_missing_printer_stops_before_the_supplies(self):
        cursor = ScriptedCursor([None])
        with self.assertRaises(api.ApiError) as caught:
            api.load_one(cursor, "imp-absente")
        self.assertEqual(caught.exception.status, 404)
        self.assertEqual(len(cursor.calls), 1)


if __name__ == "__main__":
    unittest.main()
