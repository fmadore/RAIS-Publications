from __future__ import annotations

import pytest

FIXTURE = """<?xml version='1.0' encoding='utf-8'?>
<eprints xmlns='http://eprints.org/ep2/data/2.0'>
  <eprint id='https://eref.uni-bayreuth.de/id/eprint/1'>
    <eprintid>1</eprintid>
    <eprint_status>archive</eprint_status>
    <type>article</type>
    <creators>
      <item><name><family>Kühl</family><given>Niklas</given></name><gndid>111</gndid><ubt>yes</ubt></item>
      <item><name><family>Doe</family><given>Jane</given></name></item>
    </creators>
    <title>Explaining   models to people</title>
    <language>eng</language>
    <date>2024-05-01</date>
    <keywords>XAI; Machine Learning, knowledge graphs</keywords>
    <abstract_original><text>An abstract about explainable artificial intelligence and its users.</text><lang>eng</lang></abstract_original>
    <publication>Journal of Tests</publication>
    <related_doi>doi:10.1234/abc</related_doi>
  </eprint>
  <eprint id='https://eref.uni-bayreuth.de/id/eprint/2'>
    <eprintid>2</eprintid>
    <eprint_status>archive</eprint_status>
    <type>conference_item</type>
    <creators>
      <item><name><family>Kuehl</family><given>N.</given></name><gndid>111</gndid></item>
      <item><name><family>Doe</family><given>J.</given></name></item>
      <item><name><family>Roe</family><given>Richard</given></name><ubt>yes</ubt></item>
    </creators>
    <title>Knowledge graph explanations</title>
    <language>eng</language>
    <date>2023</date>
    <keywords>Explainable Artificial Intelligence (XAI); Knowledge Graph; workshop</keywords>
    <event_title>Test Conference</event_title>
  </eprint>
  <eprint id='https://eref.uni-bayreuth.de/id/eprint/3'>
    <eprintid>3</eprintid>
    <eprint_status>archive</eprint_status>
    <type>preprint</type>
    <creators>
      <item><name><family>Roe</family><given>Richard</given></name><ubt>yes</ubt></item>
      <item><name><family>Doe</family><given>Jane</given></name></item>
    </creators>
    <title>Short</title>
    <date>2025-01-02</date>
    <succeeds>99</succeeds>
  </eprint>
</eprints>
"""


@pytest.fixture
def feed_xml() -> str:
    return FIXTURE
