"""Keep reviewed case content and the curated island's stable layout in sync."""
import copy
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from build_island_public import synchronize, synchronize_static_counts


class IslandPublicProjectionTests(unittest.TestCase):
    def setUp(self):
        self.island = {
            'meta': {'achievementSources': ['官網政績庫 1 筆']},
            'axes': ['curated-axis'], 'projects': [{'id': 'keep-project'}],
            'items': [
                {'id': 'existing-case', 'o': 1, 'i': 'P01', 'k': 'road', 'w': 42, 'p': 'keep-project'},
                {'id': 'in-804083db5d', 'o': 0, 'i': 'P02', 'k': 'policy', 'w': 7, 'p': ''},
                {'id': 'historic-case', 'o': 0, 't': 'Separate historic record', 'i': 'P03', 'w': 9},
            ],
        }
        common = {'villages': [], 'history': [{'date': '2023-06-21', 'title': '研究辦理'}],
                  'summary': 'Reviewed action', 'budget': '', 'updated': '2026-10-28'}
        self.cases = [
            dict(common, id='existing-case', title='Existing policy', status='政策實施', scope='全市政策'),
            dict(common, id='bicycle-sidewalk-space-planning', title='Bicycle space', status='持續追蹤', scope='全市政策'),
        ]

    def test_promotes_in_place_without_recounting_or_moving_history(self):
        result = synchronize(self.island, self.cases)
        self.assertEqual([x['id'] for x in result['items']], [x['id'] for x in self.island['items']])
        self.assertEqual(len(result['items']), 3)
        self.assertEqual(result['axes'], self.island['axes'])
        self.assertEqual(result['projects'], self.island['projects'])
        self.assertEqual(result['items'][2], self.island['items'][2])
        promoted = result['items'][1]
        self.assertEqual(promoted['canonicalId'], 'bicycle-sidewalk-space-planning')
        self.assertEqual(promoted['url'], 'https://www.huiwen.tw/achievement-bicycle-sidewalk-space-planning.html')
        self.assertEqual((promoted['i'], promoted['k'], promoted['w'], promoted['p']), ('P02', 'policy', 7, ''))
        self.assertEqual(sum(x['o'] == 1 for x in result['items']), 2)

    def test_citywide_scope_and_implementation_do_not_become_completed_work(self):
        result = synchronize(self.island, self.cases)
        self.assertEqual(result['items'][0]['all'], 1)
        self.assertEqual(result['items'][0]['d'], 0)
        self.assertEqual(result['items'][1]['all'], 1)
        self.assertEqual(result['items'][1]['d'], 0)

    def test_is_idempotent_and_does_not_mutate_input(self):
        original = copy.deepcopy(self.island)
        result = synchronize(self.island, self.cases)
        self.assertEqual(self.island, original)
        self.assertEqual(synchronize(result, self.cases), result)

    def test_unmapped_case_fails_instead_of_guessing_identity_or_layout(self):
        unknown = dict(self.cases[0], id='new-unmapped-case')
        with self.assertRaisesRegex(ValueError, 'explicit island identity mapping'):
            synchronize(self.island, self.cases + [unknown])

    def test_aliases_resolve_without_reusing_active_ids_or_cycles(self):
        for aliases in ({'old': 'missing'}, {'old': 'older', 'older': 'old'}, {'historic-case': 'existing-case'}):
            self.island['meta']['itemAliases'] = aliases
            with self.assertRaises(ValueError):
                synchronize(self.island, self.cases)
        self.island['meta']['itemAliases'] = {'old': 'older', 'older': 'existing-case'}
        self.assertEqual(synchronize(self.island, self.cases)['meta']['itemAliases'], self.island['meta']['itemAliases'])

    def test_static_counts_preserve_copy_and_unrelated_html(self):
        html = ('<p>全庫 99 筆</p><div id="panel-body" data-static-list>全庫 99 筆'
                '<button data-fb="island" data-id="P01"><small>Curated note・99 筆</small></button>'
                '<button data-fb="island" data-id="Q1"><small>Separate module</small></button></div><p>Keep</p>')
        data = {'islands': [{'id': 'P01'}, {'id': 'Q1'}], 'items': [{'i': 'P01'}, {'i': 'BASE'}]}
        result = synchronize_static_counts(html, data)
        self.assertEqual(result, html.replace('data-static-list>全庫 99 筆', 'data-static-list>全庫 2 筆').replace('Curated note・99 筆', 'Curated note・1 筆'))
        self.assertEqual(synchronize_static_counts(result, data), result)
        with self.assertRaisesRegex(ValueError, 'rows differ'):
            synchronize_static_counts(html, dict(data, islands=data['islands'] + [{'id': 'X1'}]))


if __name__ == '__main__':
    unittest.main()
