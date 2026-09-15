import importlib.util
from pathlib import Path
import tempfile
import unittest
import zipfile


def module(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).resolve().parents[1] / 'scripts' / f'{name}.py')
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


audio = module('fadr-audio')
extractor = module('fadr-extract')


class PipelineTests(unittest.TestCase):
    def test_match_rejects_wrong_recordings(self):
        track = {'title': 'THAT GUY', 'artist': 'Tyler, The Creator', 'duration': 167.533}
        candidate = {'title': 'Tyler, The Creator - THAT GUY (Audio)', 'channel': 'Music', 'duration': 168}
        self.assertIsNotNone(audio.match_score(track, candidate))
        for title in ['THAT GUY (clean)', 'THAT GUY live', 'THAT GUY cover', 'THAT GUY (slowed)', 'Something Else']:
            self.assertIsNone(audio.match_score(track, {**candidate, 'title': title}))
        self.assertIsNone(audio.match_score(track, {**candidate, 'duration': 30}))
        self.assertIsNone(audio.match_score(track, {**candidate, 'title': 'THAT GUY', 'channel': 'Someone Else'}))

    def test_matching_handles_accents_and_official_audio(self):
        track = {'title': 'FORLÖRN', 'artist': 'Black Hibiscus', 'duration': 169.582}
        base = {'title': 'FORLORN', 'channel': 'Black Hibiscus', 'duration': 170}
        self.assertGreater(audio.match_score(track, {**base, 'channel': 'Black Hibiscus - Topic'}), audio.match_score(track, base))

    def test_extract_nested_stems_and_verify_resume(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive, output = root / 'stems.zip', root / 'stems'
            with zipfile.ZipFile(archive, 'w') as z:
                z.writestr('Song/Bass - Song.mp3', b'fake audio bytes')
                z.writestr('Song/Piano - Song.mp3', b'other audio bytes')
            first = extractor.extract(archive, output, ['Bass', 'Piano'])
            self.assertEqual(len(first['files']), 2)
            self.assertEqual(extractor.extract(archive, output, ['Bass', 'Piano']), first)
            (output / 'Bass - Song.mp3').write_bytes(b'changed')
            with self.assertRaisesRegex(ValueError, 'changed'):
                extractor.extract(archive, output)

    def test_archive_failures_leave_no_partial_song(self):
        cases = [('../escape.mp3', 'Unsafe'), ('/absolute.mp3', 'Unsafe'), ('C:\\escape.mp3', 'Unsafe'), ('Song/Bass - Song.mp3', 'Duplicate')]
        for bad, expected in cases:
            with self.subTest(bad=bad), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                archive, output = root / 'stems.zip', root / 'stems'
                with zipfile.ZipFile(archive, 'w') as z:
                    z.writestr('Bass - Song.mp3', b'bytes')
                    z.writestr(bad, b'bytes')
                with self.assertRaisesRegex(ValueError, expected):
                    extractor.extract(archive, output)
                self.assertFalse(output.exists())
                self.assertEqual(list(root.glob('.extract-*')), [])

    def test_basic_export_cannot_pass_as_pro(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive, output = root / 'stems.zip', root / 'stems'
            with zipfile.ZipFile(archive, 'w') as z:
                z.writestr('Bass - Song.mp3', b'bytes')
            with self.assertRaisesRegex(ValueError, 'missing requested stems: Piano'):
                extractor.extract(archive, output, ['Bass', 'Piano'])
            self.assertFalse(output.exists())

    def test_fadr_labels_map_to_zip_names_without_reusing_stems(self):
        extractor.verify_roles(['Vocals-lead - Song.mp3', 'Pro-other - Song.mp3'], ['Lead Vocals', 'Melodies'])
        extractor.verify_roles(['Other - Song.mp3', 'Pro-other - Song.mp3'], ['Melodies', 'Melodies'])
        with self.assertRaisesRegex(ValueError, 'missing requested stems: Melodies'):
            extractor.verify_roles(['Pro-other - Song.mp3'], ['Melodies', 'Melodies'])


if __name__ == '__main__':
    unittest.main()
