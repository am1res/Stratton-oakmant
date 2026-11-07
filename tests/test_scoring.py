from django.test import SimpleTestCase

from evaluations.services.scoring import CriterionSpec, compute

C1 = CriterionSpec("C1", "binary", 10)
C2 = CriterionSpec("C2", "binary", 15)
C3 = CriterionSpec("C3", "binary", 20)
C4 = CriterionSpec("C4", "scale", 20, (0, 5, 10, 15, 20))
C5 = CriterionSpec("C5", "binary", 15)
C6 = CriterionSpec("C6", "scale", 15, (0, 4, 7, 10))
C7 = CriterionSpec("C7", "binary", 5)
C8 = CriterionSpec("C8", "flag", 0)
ALL = [C1, C2, C3, C4, C5, C6, C7, C8]


def score(values, rounding=2):
    return compute(zip(ALL, values), rounding)


class ScoringTests(SimpleTestCase):
    def test_perfect_score(self):
        s = score(["YES", "YES", "YES", "20", "YES", "10", "YES", "NO"])
        self.assertEqual(s.total, 100.0)
        self.assertFalse(s.critical_violation)

    def test_scale_conversion_matches_checklist_example(self):
        s = score(["YES", "YES", "YES", "20", "YES", "7", "YES", "NO"])
        self.assertEqual(s.points["C6"], 10.5)  # 7 / 10 * 15
        self.assertEqual(s.total, 95.5)

    def test_na_weight_is_redistributed(self):
        # C3 (20) and C7 (5) are N/A: applicable weight = 75; earned = 10 + 0 + 15 + 15 + 15 = 55.
        s = score(["YES", "NO", "N/A", "15", "YES", "10", "N/A", "NO"])
        self.assertIsNone(s.points["C3"])
        self.assertEqual(s.total, round(55 / 75 * 100, 2))  # 73.33

    def test_total_not_calculated_without_applicable_weight(self):
        specs = [CriterionSpec("X", "binary", 10, ()), C8]
        s = compute(zip(specs, ["N/A", "NO"]))
        self.assertIsNone(s.total)

    def test_critical_flag_reported_separately(self):
        s = score(["YES", "YES", "YES", "20", "YES", "10", "YES", "YES"])
        self.assertTrue(s.critical_violation)
        self.assertEqual(s.total, 100.0)
        self.assertIsNone(s.points["C8"])

    def test_rounding_is_half_up(self):
        specs = [CriterionSpec("A", "binary", 1), CriterionSpec("B", "binary", 7)]
        # 1/8 * 100 = 12.5 -> 13 with 0 decimals (banker's rounding would give 12)
        self.assertEqual(compute(zip(specs, ["YES", "NO"]), rounding=0).total, 13.0)

    def test_section_scores(self):
        specs = [
            CriterionSpec("A", "binary", 10, (), "Opening"),
            CriterionSpec("B", "binary", 10, (), "Opening"),
            CriterionSpec("C", "binary", 20, (), "Solution"),
        ]
        s = compute(zip(specs, ["YES", "NO", "YES"]))
        self.assertEqual(s.sections, {"Opening": 50.0, "Solution": 100.0})
        self.assertEqual(s.total, 75.0)
