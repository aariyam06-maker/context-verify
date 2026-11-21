import sys
from pathlib import Path
import numpy as np
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"backend"))
from app.ml.temporal_localization import localize_single_deletion
from app.ml import video_io

def test_removed_interval_and_static_abstention(tmp_path):
    rng=np.random.default_rng(41);base=rng.integers(0,256,(120,240,3),dtype=np.uint8)
    frames=[np.ascontiguousarray(base[:96,i:i+128]) for i in range(90)]
    original=video_io.write_video(frames,30,tmp_path/'source.mp4',crf=18)
    edited=video_io.write_video(frames[:30]+frames[60:],30,tmp_path/'cut.mp4',crf=23)
    result=localize_single_deletion(original,edited)
    assert result['localized'] and abs(result['start']-1)<.11 and abs(result['end']-2)<.11
    static=[frames[0]]*90
    a=video_io.write_video(static,30,tmp_path/'static.mp4');b=video_io.write_video(static[:60],30,tmp_path/'static-cut.mp4')
    assert not localize_single_deletion(a,b)['localized']


def test_short_deletion_event_is_refined_without_changing_direction(monkeypatch):
    from types import SimpleNamespace
    from app.ml import temporal_localization, tamper_service
    monkeypatch.setattr(temporal_localization, 'localize_single_deletion', lambda *a: {'localized': True, 'start': 2.1, 'end': 2.333, 'boundary_resolution_seconds': .1})
    original = SimpleNamespace(path='original.mp4', duration=6.)
    edited = SimpleNamespace(path='edited.mp4', duration=6.-7/30)
    metrics = {'disorder': 0., 'lapvar': 0., 'bpp': 0.}
    pair = SimpleNamespace(a=original, b=edited, events=[], metrics_a=metrics, metrics_b=metrics, region={'found': False}, speed_ratio=1.)
    events = tamper_service._events(pair, 'b', {})
    assert events[0]['type'] == 'removed_segment'
    assert events[0]['in'] == 'original' and events[0]['start'] == 2.1
