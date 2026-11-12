import importlib.util
import json
from pathlib import Path
import sys
import types
import unittest
from datetime import datetime, timezone
from unittest.mock import MagicMock, patch


# 测试调度及流程衔接，无需安装或启动浏览器，也不发送真实 HTTP 请求。
requests_stub = types.ModuleType("requests")
requests_stub.post = MagicMock()
requests_stub.get = MagicMock()
requests_stub.put = MagicMock()
selenium_stub = types.ModuleType("seleniumbase")
selenium_stub.SB = MagicMock()
spec = importlib.util.spec_from_file_location("renew_app", Path(__file__).resolve().parents[1] / "app.py")
app = importlib.util.module_from_spec(spec)
with patch.dict(sys.modules, {"requests": requests_stub, "seleniumbase": selenium_stub}):
    spec.loader.exec_module(app)


class ExpiryDateTests(unittest.TestCase):
    def read(self, value):
        browser = MagicMock()
        browser.execute_script.return_value = value
        return app._get_server_expiry_date(browser)

    def test_iso_expiry_dates_including_year_rollover_and_leap_day(self):
        for value in ["2026-11-16", "2026-12-31", "2027-01-01", "2028-02-29"]:
            with self.subTest(value=value):
                self.assertEqual(self.read(value), value)
        self.assertEqual(self.read(" 2026-11-16 "), "2026-11-16")

    def test_missing_malformed_and_invalid_expiry_dates(self):
        for value in [None, "", "2026-02-30", "2026-11-31", "2027-02-29", "2026-1-6", "as of 16 November", "Success", 20261116]:
            with self.subTest(value=value):
                self.assertIsNone(self.read(value))

    def test_browser_read_failure_has_no_date(self):
        browser = MagicMock()
        browser.execute_script.side_effect = RuntimeError("browser unavailable")
        self.assertIsNone(app._get_server_expiry_date(browser))


class AccountTests(unittest.TestCase):
    def setUp(self):
        self.accounts = [{"email": "one@example.com", "password": "first"}, {"email": "two@example.com", "password": "second"}]
        self.environment = patch.dict(app.os.environ, {}, clear=True)
        self.environment.start()
        self.config = patch.object(app, "ACCOUNTS_JSON", json.dumps(self.accounts))
        self.config.start()
        self.addCleanup(self.environment.stop)
        self.addCleanup(self.config.stop)

    def test_manual_all_and_targeted_dispatch(self):
        self.assertEqual(app.load_accounts(), self.accounts)
        app.os.environ["TARGET_ACCOUNT_IDS"] = "null"
        self.assertEqual(app.load_accounts(), self.accounts)
        app.os.environ["TARGET_ACCOUNT_IDS"] = json.dumps([app._account_id(" TWO@example.com ")])
        self.assertEqual(app.load_accounts(), [self.accounts[1]])

    def test_unknown_or_invalid_target_never_falls_back_to_all(self):
        for targets in ["[]", "{}", "invalid", '["raw@example.com"]', json.dumps(["a" * 64])]:
            with self.subTest(targets=targets), self.assertRaises(ValueError):
                app.os.environ["TARGET_ACCOUNT_IDS"] = targets
                app.load_accounts()

    def test_removed_account_does_not_block_other_due_accounts(self):
        app.os.environ["TARGET_ACCOUNT_IDS"] = json.dumps(["a" * 64, app._account_id("two@example.com")])
        self.assertEqual(app.load_accounts(), [self.accounts[1]])

    def test_duplicate_accounts_and_single_account_compatibility(self):
        with patch.object(app, "ACCOUNTS_JSON", json.dumps([self.accounts[0], {"email": " ONE@EXAMPLE.COM ", "password": "other"}])):
            with self.assertRaisesRegex(ValueError, "重复邮箱"):
                app.load_accounts()
        with patch.object(app, "ACCOUNTS_JSON", ""), patch.object(app, "LEGACY_EMAIL", "one@example.com"), patch.object(app, "LEGACY_PASSWORD", "first"):
            self.assertEqual(app.load_accounts(), [self.accounts[0]])


class ScheduleTests(unittest.TestCase):
    def schedule(self, renewal_date, now="2026-11-04T04:00:00+00:00"):
        return app._build_account_schedule("one@example.com", renewal_date, datetime.fromisoformat(now))

    def test_triggers_on_renewal_date_including_month_year_and_leap_day(self):
        for renewal_date, expected in [
            ("2026-11-07", "2026-11-07T00:12:00.000Z"),
            ("2026-12-01", "2026-12-01T00:12:00.000Z"),
            ("2027-01-01", "2027-01-01T00:12:00.000Z"),
            ("2028-02-29", "2028-02-29T00:12:00.000Z"),
            ("2028-03-01", "2028-03-01T00:12:00.000Z"),
        ]:
            with self.subTest(renewal_date=renewal_date):
                self.assertEqual(self.schedule(renewal_date)["next_trigger_at"], expected)

    def test_past_preferred_time_retries_next_day(self):
        self.assertEqual(self.schedule("2026-11-07", "2026-11-07T04:00:00+00:00")["next_trigger_at"], "2026-11-08T00:12:00.000Z")
        self.assertEqual(self.schedule("2026-11-07", "2026-11-07T00:12:00+00:00")["next_trigger_at"], "2026-11-08T00:12:00.000Z")

    def test_before_daily_trigger_keeps_same_day(self):
        self.assertEqual(self.schedule("2026-11-07", "2026-11-07T00:11:59+00:00")["next_trigger_at"], "2026-11-07T00:12:00.000Z")

    def test_unknown_date_retries_next_beijing_day(self):
        self.assertEqual(self.schedule(None)["next_trigger_at"], "2026-11-05T00:12:00.000Z")
        self.assertEqual(self.schedule(None, "2026-12-31T20:00:00+00:00")["next_trigger_at"], "2027-01-02T00:12:00.000Z")


def cf_response(result=None, status=200, success=True, raw=False):
    response = MagicMock()
    response.status_code = status
    response.ok = 200 <= status < 300
    response.json.return_value = result if raw else {"success": success, "result": result}
    return response


class ReportTests(unittest.TestCase):
    def setUp(self):
        self.environment = patch.dict(app.os.environ, {
            "CF_ACCOUNT_ID": "cf-account", "CF_WORKER_NAME": "renew-worker", "CF_API_TOKEN": "test-token",
        }, clear=True)
        self.environment.start()
        self.addCleanup(self.environment.stop)
        app._get_cloudflare_kv_namespace.cache_clear()
        self.addCleanup(app._get_cloudflare_kv_namespace.cache_clear)
        clock = patch.object(app, "datetime", wraps=datetime)
        clock.start().now.return_value = datetime(2026, 11, 4, 4, tzinfo=timezone.utc)
        self.addCleanup(clock.stop)
        settings = {"bindings": [
            {"name": "OTHER_KV", "type": "kv_namespace", "namespace_id": "other-namespace"},
            {"name": "RENEW_KV", "type": "kv_namespace", "namespace_id": "renew-namespace"},
        ]}
        get = patch.object(app.requests, "get", return_value=cf_response(settings))
        self.get = get.start()
        self.addCleanup(get.stop)
        put = patch.object(app.requests, "put", return_value=cf_response())
        self.put = put.start()
        self.addCleanup(put.stop)
        self.value_url = "https://api.cloudflare.com/client/v4/accounts/cf-account/storage/kv/namespaces/renew-namespace/values/schedule%3A" + app._account_id("one@example.com")

    def test_original_secrets_discover_binding_and_write_hash_and_dates_only(self):
        self.assertTrue(app._report_account_schedule(" ONE@example.com ", "2026-11-07"))
        self.get.assert_called_once_with(
            "https://api.cloudflare.com/client/v4/accounts/cf-account/workers/scripts/renew-worker/settings",
            headers={"Authorization": "Bearer test-token"}, timeout=20,
        )
        args, kwargs = self.put.call_args
        self.assertEqual(args, (self.value_url,))
        self.assertEqual(kwargs["headers"], {"Authorization": "Bearer test-token", "Content-Type": "application/octet-stream"})
        self.assertEqual(kwargs["timeout"], 20)
        self.assertEqual(json.loads(kwargs["data"]), {
            "account_id": app._account_id("one@example.com"), "renewal_date": "2026-11-07",
            "next_trigger_at": "2026-11-07T00:12:00.000Z", "updated_at": "2026-11-04T04:00:00.000Z",
        })

    def test_binding_lookup_is_cached_across_accounts(self):
        self.assertTrue(app._report_account_schedule("one@example.com", "2026-11-07"))
        self.assertTrue(app._report_account_schedule("two@example.com", "2026-11-12"))
        self.assertEqual(self.get.call_count, 1)
        self.assertEqual(self.put.call_count, 2)
        self.assertNotEqual(self.put.call_args_list[0].args[0], self.put.call_args_list[1].args[0])

    @patch.object(app, "send_tg_message")
    def test_successful_renewal_saves_new_expiry_and_schedules_that_day(self, send):
        state = {"renewal_date": "2026-11-12"}
        browser = MagicMock()
        browser.execute_script.return_value = "2026-11-16"
        with patch.object(app, "_read_alert", return_value="Your service has been renewed."):
            app._check_renew_result(browser, None, "one@example.com", state)
        self.assertTrue(app._report_account_schedule("one@example.com", state["renewal_date"]))
        saved = json.loads(self.put.call_args.kwargs["data"])
        self.assertEqual(saved["renewal_date"], "2026-11-16")
        self.assertEqual(saved["next_trigger_at"], "2026-11-16T00:12:00.000Z")
        self.get.assert_called_once()

    def test_missing_or_wrong_binding_is_not_written(self):
        for binding in [[], [{"name": "RENEW_KV", "type": "plain_text", "text": "not a namespace"}]]:
            with self.subTest(binding=binding):
                self.get.return_value = cf_response({"bindings": binding})
                self.assertFalse(app._report_account_schedule("one@example.com", "2026-11-07"))
        self.put.assert_not_called()

    def test_permissions_and_unsuccessful_settings_response_fail(self):
        for response in [cf_response(status=403), cf_response(success=False)]:
            with self.subTest(response=response):
                self.get.return_value = response
                self.assertFalse(app._report_account_schedule("one@example.com", "2026-11-07"))
        self.put.assert_not_called()

    def test_failed_kv_write_is_not_silently_successful(self):
        for response in [cf_response(status=403), cf_response(success=False)]:
            with self.subTest(response=response):
                self.put.return_value = response
                self.assertFalse(app._report_account_schedule("one@example.com", "2026-11-07"))

    def test_unknown_date_preserves_future_schedule(self):
        previous = app._build_account_schedule("one@example.com", "2026-11-07", datetime(2026, 11, 4, 4, tzinfo=timezone.utc))
        self.get.side_effect = [self.get.return_value, cf_response(previous, raw=True)]
        self.assertTrue(app._report_account_schedule("one@example.com", None))
        self.assertEqual(self.get.call_args.args, (self.value_url,))
        self.put.assert_not_called()

    def test_unknown_date_creates_schedule_for_new_account(self):
        self.get.side_effect = [self.get.return_value, cf_response(status=404)]
        self.assertTrue(app._report_account_schedule("one@example.com", None))
        saved = json.loads(self.put.call_args.kwargs["data"])
        self.assertIsNone(saved["renewal_date"])
        self.assertEqual(saved["next_trigger_at"], "2026-11-05T00:12:00.000Z")

    def test_unknown_date_reschedules_overdue_account(self):
        previous = {"next_trigger_at": "2026-11-03T00:12:00.000Z"}
        self.get.side_effect = [self.get.return_value, cf_response(previous, raw=True)]
        self.assertTrue(app._report_account_schedule("one@example.com", None))
        self.assertEqual(json.loads(self.put.call_args.kwargs["data"])["next_trigger_at"], "2026-11-05T00:12:00.000Z")

    def test_failed_existing_value_read_does_not_overwrite_schedule(self):
        self.get.side_effect = [self.get.return_value, cf_response(status=403)]
        self.assertFalse(app._report_account_schedule("one@example.com", None))
        self.put.assert_not_called()

    def test_network_failure_is_not_silently_successful(self):
        self.get.side_effect = RuntimeError("network failure")
        self.assertFalse(app._report_account_schedule("one@example.com", "2026-11-07"))
        self.put.assert_not_called()

    def test_manual_run_without_cloudflare_configuration(self):
        with patch.dict(app.os.environ, {}, clear=True):
            self.assertTrue(app._report_account_schedule("one@example.com", None))
        self.get.assert_not_called()
        self.put.assert_not_called()
        del app.os.environ["CF_API_TOKEN"]
        self.assertFalse(app._report_account_schedule("one@example.com", None))
        self.get.assert_not_called()


class FlowTests(unittest.TestCase):
    @patch.object(app, "send_tg_message")
    @patch.object(app.time, "sleep")
    def test_dashboard_not_due_prompt_still_visits_detail_to_read_expiry(self, sleep, send):
        state = {"renewal_date": None}
        browser = MagicMock()
        browser.execute_script.return_value = "2026-11-16"
        prompt = "You can't renew your server yet. You will be able to as of 15 November."
        with patch.object(app, "_read_alert", side_effect=[prompt, ""]):
            self.assertIsNone(app._goto_server_detail(browser, "one@example.com", state))
        browser.find_element.return_value.click.assert_called_once()
        self.assertEqual(state["renewal_date"], "2026-11-16")

    @patch.object(app, "send_tg_message")
    @patch.object(app.time, "sleep")
    def test_detail_page_expiry_is_used_instead_of_alert_date(self, sleep, send):
        state = {"renewal_date": None}
        browser = MagicMock()
        browser.execute_script.return_value = "2026-11-16"
        prompt = "You can't renew your server yet. You will be able to as of 15 November."
        with patch.object(app, "_read_alert", side_effect=["", prompt]):
            self.assertIsNone(app._goto_server_detail(browser, "one@example.com", state))
        self.assertEqual(state["renewal_date"], "2026-11-16")

    @patch.object(app.time, "sleep")
    def test_expiry_does_not_skip_a_renewal_without_a_not_due_prompt(self, sleep):
        state = {"renewal_date": None}
        browser = MagicMock()
        browser.execute_script.return_value = "2026-11-16"
        with patch.object(app, "_read_alert", return_value=""):
            self.assertTrue(app._goto_server_detail(browser, "one@example.com", state))
        self.assertEqual(state["renewal_date"], "2026-11-16")

    @patch.object(app, "send_tg_message")
    def test_success_refreshes_before_reading_new_expiry(self, send):
        state = {"renewal_date": "2026-11-12"}
        browser = MagicMock()

        def read_expiry(script):
            browser.refresh_page.assert_called_once()
            return "2026-11-16"

        browser.execute_script.side_effect = read_expiry
        with patch.object(app, "_read_alert", return_value="Your service has been renewed."):
            app._check_renew_result(browser, None, "one@example.com", state)
        self.assertEqual(state["renewal_date"], "2026-11-16")

    @patch.object(app, "send_tg_message")
    @patch.object(app.time, "sleep")
    def test_success_waits_for_expiry_to_appear(self, sleep, send):
        state = {"renewal_date": "2026-11-12"}
        browser = MagicMock()
        browser.execute_script.side_effect = [None, None, "2026-11-16"]
        with patch.object(app, "_read_alert", return_value="Your service has been renewed."):
            app._check_renew_result(browser, None, "one@example.com", state)
        self.assertEqual(state["renewal_date"], "2026-11-16")
        self.assertEqual(sleep.call_args_list, [unittest.mock.call(2), unittest.mock.call(2)])

    @patch.object(app, "send_tg_message")
    @patch.object(app.time, "sleep")
    def test_success_without_expiry_discards_pre_renewal_date(self, sleep, send):
        state = {"renewal_date": "2026-11-12"}
        browser = MagicMock()
        browser.execute_script.return_value = None
        with patch.object(app, "_read_alert", return_value="Your service has been renewed."):
            app._check_renew_result(browser, None, "one@example.com", state)
        self.assertIsNone(state["renewal_date"])

    @patch.object(app, "send_tg_message")
    def test_failed_refresh_does_not_reuse_old_expiry(self, send):
        state = {"renewal_date": "2026-11-12"}
        browser = MagicMock()
        browser.refresh_page.side_effect = RuntimeError("refresh failed")
        browser.execute_script.return_value = "2026-11-12"
        with patch.object(app, "_read_alert", return_value="Your service has been renewed."):
            app._check_renew_result(browser, None, "one@example.com", state)
        self.assertIsNone(state["renewal_date"])
        browser.execute_script.assert_not_called()

    @patch.object(app, "send_tg_message")
    @patch.object(app.time, "sleep")
    def test_alert_date_is_not_used_when_expiry_is_missing(self, sleep, send):
        state = {"renewal_date": None}
        browser = MagicMock()
        browser.execute_script.return_value = None
        prompt = "You can't renew your server yet. You will be able to as of 15 November."
        with patch.object(app, "_read_alert", return_value=prompt):
            app._check_renew_result(browser, None, "one@example.com", state)
        self.assertIsNone(state["renewal_date"])

    @patch.object(app, "send_tg_message")
    @patch.object(app.time, "sleep")
    def test_expiry_is_captured_without_result_alert(self, sleep, send):
        state = {"renewal_date": "2026-11-12"}
        browser = MagicMock()
        browser.execute_script.return_value = "2026-11-16"
        with patch.object(app, "_read_alert", return_value=""):
            app._check_renew_result(browser, None, "one@example.com", state)
        self.assertEqual(state["renewal_date"], "2026-11-16")

    def test_main_reports_each_account_even_if_first_login_fails(self):
        accounts = [{"email": "one@example.com", "password": "first"}, {"email": "two@example.com", "password": "second"}]

        def renew(browser, email, index, state):
            state["renewal_date"] = "2026-11-07"
            return True

        with patch.object(app, "load_accounts", return_value=accounts), patch.object(app, "SB"), patch.object(app, "login", side_effect=[False, True]), patch.object(app, "renew_server", side_effect=renew), patch.object(app, "send_tg_message"), patch.object(app, "_report_account_schedule", return_value=True) as report:
            with self.assertRaises(SystemExit) as result:
                app.main()
        self.assertEqual(result.exception.code, 1)
        self.assertEqual(report.call_args_list, [unittest.mock.call("one@example.com", None), unittest.mock.call("two@example.com", "2026-11-07")])

    def test_main_treats_failed_schedule_sync_as_failure_and_continues(self):
        accounts = [{"email": "one@example.com", "password": "first"}, {"email": "two@example.com", "password": "second"}]
        with patch.object(app, "load_accounts", return_value=accounts), patch.object(app, "SB"), patch.object(app, "login", return_value=True), patch.object(app, "renew_server", return_value=True), patch.object(app, "_report_account_schedule", side_effect=[False, True]) as report:
            with self.assertRaises(SystemExit):
                app.main()
        self.assertEqual(report.call_count, 2)


if __name__ == "__main__":
    unittest.main()
