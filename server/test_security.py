"""Contrôles défensifs : adresses SNMP, communauté et limite de connexion."""

import unittest

import app as api
from snmp_levels import COMMUNITY_RE, queryable_ipv4


class SwatchTests(unittest.TestCase):
    def test_color_cannot_escape_the_style(self):
        self.assertEqual(api.safe_swatch("#0b7c8c"), "#0b7c8c")
        self.assertEqual(api.safe_swatch('red;}</style><script>alert(1)'), "#5b4636")
        self.assertEqual(api.safe_swatch("url(https://example.test)"), "#5b4636")


class AddressTests(unittest.TestCase):
    def test_printer_networks_stay_allowed(self):
        self.assertTrue(queryable_ipv4("192.168.1.20"))
        self.assertTrue(queryable_ipv4("10.1.2.3"))
        self.assertTrue(queryable_ipv4("172.16.4.5"))
        self.assertTrue(queryable_ipv4("195.200.200.98"))

    def test_local_and_link_local_are_refused(self):
        for address in ("127.0.0.1", "0.0.0.1", "169.254.169.254", "224.0.0.1", "255.255.255.255", "localhost"):
            self.assertFalse(queryable_ipv4(address), address)


class CommunityTests(unittest.TestCase):
    def test_option_like_community_is_refused(self):
        self.assertFalse(COMMUNITY_RE.fullmatch("-public"))
        self.assertFalse(COMMUNITY_RE.fullmatch("-v1"))
        self.assertIsNotNone(COMMUNITY_RE.fullmatch("public"))
        self.assertIsNotNone(COMMUNITY_RE.fullmatch("bureau-1"))


class LoginLimitTests(unittest.TestCase):
    def setUp(self):
        api._login_failures.clear()
        self.client = api.app.test_client()
        self.original_run = api.run
        api.run = lambda fn: None

    def tearDown(self):
        api.run = self.original_run
        api._login_failures.clear()

    def attempt(self, address="203.0.113.8"):
        return self.client.post(
            "/api/login",
            json={"identifiant": "admin", "motDePasse": "mauvais-mot"},
            headers={"X-Real-IP": address},
        )

    def test_repeated_failures_are_limited(self):
        for _ in range(api.LOGIN_LIMIT):
            response = self.attempt()
            self.assertEqual(response.status_code, 401)
        blocked = self.attempt()
        self.assertEqual(blocked.status_code, 429)
        self.assertIn("Trop de tentatives", blocked.get_json()["error"])

    def test_form_post_is_refused(self):
        response = self.client.post(
            "/api/login",
            data={"identifiant": "admin", "motDePasse": "secret"},
            headers={"X-Real-IP": "203.0.113.9"},
        )
        self.assertEqual(response.status_code, 415)

    def test_other_address_is_not_blocked_by_the_first(self):
        for _ in range(api.LOGIN_LIMIT):
            self.attempt("203.0.113.10")
        other = self.attempt("203.0.113.11")
        self.assertEqual(other.status_code, 401)


if __name__ == "__main__":
    unittest.main()
