"""Contrôles du décodage SNMP, sans interroger le réseau."""

import unittest

from snmp_levels import apply_reading, interpret, named_supplies, parse_walk, percentage, valid_ipv4

SAMPLE = """
.1.3.6.1.2.1.43.11.1.1.5.1.1 3
.1.3.6.1.2.1.43.11.1.1.6.1.1 "Black Toner"
.1.3.6.1.2.1.43.11.1.1.8.1.1 100
.1.3.6.1.2.1.43.11.1.1.9.1.1 40
.1.3.6.1.2.1.43.11.1.1.5.1.2 21
.1.3.6.1.2.1.43.11.1.1.6.1.2 "Cyan Cartridge"
.1.3.6.1.2.1.43.11.1.1.8.1.2 2000
.1.3.6.1.2.1.43.11.1.1.9.1.2 500
.1.3.6.1.2.1.43.11.1.1.5.1.3 15
.1.3.6.1.2.1.43.11.1.1.6.1.3 "Kit de fusion"
.1.3.6.1.2.1.43.11.1.1.8.1.3 100000
.1.3.6.1.2.1.43.11.1.1.9.1.3 25000
.1.3.6.1.2.1.43.11.1.1.5.1.4 3
.1.3.6.1.2.1.43.11.1.1.6.1.4 "Noir photo"
.1.3.6.1.2.1.43.11.1.1.8.1.4 100
.1.3.6.1.2.1.43.11.1.1.9.1.4 15
.1.3.6.1.2.1.43.11.1.1.5.1.5 9
.1.3.6.1.2.1.43.11.1.1.6.1.5 "Tambour"
.1.3.6.1.2.1.43.11.1.1.8.1.5 100
.1.3.6.1.2.1.43.11.1.1.9.1.5 -3
"""


class SnmpLevelsTest(unittest.TestCase):
    def test_percentages_and_kinds(self):
        reading = interpret(parse_walk(SAMPLE))
        self.assertEqual(reading["channels"], {"noir": 40, "cyan": 25})
        self.assertEqual(reading["extras"], [{"label": "Noir photo", "value": 15, "swatch": "#2b3038"}])
        self.assertEqual(reading["kits"], [{"label": "Kit de fusion", "value": 25}])

    def test_plotter_keeps_colors_as_extras(self):
        reading = interpret(parse_walk(SAMPLE), plotter=True)
        labels = [item["label"] for item in reading["extras"]]
        self.assertEqual(reading["channels"], {})
        self.assertIn("Black Toner", labels)
        self.assertIn("Cyan Cartridge", labels)

    def test_apply_updates_existing_kit_and_keeps_manual_toner(self):
        printer = {
            "noir": 100,
            "cyan": None,
            "extra": [{"key": "ton-1", "label": "Gris", "value": 80, "swatch": "#777"}],
            "kits": [{"label": "Kit de fusion", "level": 90}],
        }
        apply_reading(printer, interpret(parse_walk(SAMPLE)))
        self.assertEqual(printer["noir"], 40)
        self.assertEqual(printer["cyan"], 25)
        self.assertEqual(printer["extra"][0]["value"], 80)
        self.assertEqual(printer["extra"][1]["label"], "Noir photo")
        self.assertEqual(printer["kits"][0]["level"], 25)

    def test_named_supplies_keep_the_printer_labels(self):
        reading = named_supplies(parse_walk(SAMPLE))
        types = [item["type"] for item in reading["cartouches"]]
        self.assertEqual(types, ["Black Toner", "Cyan Cartridge", "Noir photo"])
        self.assertEqual(reading["cartouches"][0]["value"], 40)
        self.assertEqual(reading["cartouches"][1]["value"], 25)
        self.assertEqual(reading["kits"], [{"label": "Kit de fusion", "level": 25}])

    def test_unknown_level_is_ignored(self):
        self.assertIsNone(percentage(-3, 100))
        self.assertIsNone(percentage(None, 100))

    def test_ipv4(self):
        self.assertTrue(valid_ipv4("195.200.200.12"))
        self.assertFalse(valid_ipv4("Localhost"))
        self.assertFalse(valid_ipv4("195.200.200.512"))


if __name__ == "__main__":
    unittest.main()
