import multiprocessing as mp

import pytest

from app.research.vector_memory import HashingEmbedder, VectorMemory
from app.research.vector_store import SqliteVectorStore

DOCS = [("a", "bitcoin halving reduces miner supply", "research"), ("b", "ethereum staking yield and validator queue", "research"), ("c", "risk limit breached after leverage spike", "lesson"), ("d", "bitcoin miners sell supply after halving", "note")]


def fill(s):
    for i, t, k in DOCS:
        s.add(t, id=i, kind=k, meta={"n": i})
    return s


def test_matches_in_memory_vector_memory_exactly():
    mem, db = VectorMemory(), SqliteVectorStore()
    for i, t, k in DOCS:
        mem.add(t, id=i, kind=k, now=1.0); db.add(t, id=i, kind=k, now=1.0)
    for q in ["bitcoin miners halving", "leverage risk", "staking"]:
        a, b = mem.search(q, k=4), db.search(q, k=4)
        assert [h.entry.id for h in a] == [h.entry.id for h in b]
        assert all(abs(x.score - y.score) < 1e-6 for x, y in zip(a, b))
    assert [h.entry.id for h in db.search("bitcoin", k=5, kind="note")] == ["d"]
    assert db.search("") == [] and SqliteVectorStore().search("x") == []


def test_upsert_remove_get_and_validation():
    s = fill(SqliteVectorStore())
    assert len(s) == 4 and s.get("a").meta == {"n": "a"}
    s.add("totally different text about gold", id="a", kind="note")
    assert len(s) == 4 and s.get("a").text.startswith("totally") and s.search("gold", k=1)[0].entry.id == "a"
    assert s.remove("a") and not s.remove("a") and len(s) == 3 and s.get("a") is None
    assert all(h.entry.id != "a" for h in s.search("gold"))
    with pytest.raises(ValueError):
        s.add("   ")
    assert s.add("same").id == s.add("same").id and len(s) == 4  # content-hash ids are idempotent


def test_survives_restart_and_rejects_wrong_dimension(tmp_path):
    p = str(tmp_path / "v.db")
    s = fill(SqliteVectorStore(p)); s.close()
    s2 = SqliteVectorStore(p)
    assert len(s2) == 4 and s2.search("ethereum staking", k=1)[0].entry.id == "b"
    s2.close()
    with pytest.raises(ValueError):
        SqliteVectorStore(p, embedder=HashingEmbedder(64))


def test_add_many_is_atomic(tmp_path):
    s = SqliteVectorStore(str(tmp_path / "a.db"))
    with pytest.raises(ValueError):
        s.add_many([{"text": "ok one", "id": "1"}, {"text": "  ", "id": "2"}])
    assert len(s) == 0
    assert s.add_many([{"text": "ok one", "id": "1"}, {"text": "ok two", "id": "2"}]) == 2 and len(s) == 2


def _writer(path, start):
    s = SqliteVectorStore(path)
    for i in range(start, start + 25):
        s.add(f"note number {i} about markets", id=f"n{i}")
    s.close()


def test_two_processes_can_write_the_same_file_and_readers_see_fresh_data(tmp_path):
    p = str(tmp_path / "shared.db")
    reader = SqliteVectorStore(p)
    assert reader.search("markets") == []
    ps = [mp.get_context("spawn").Process(target=_writer, args=(p, i * 100)) for i in range(3)]
    [x.start() for x in ps]; [x.join(60) for x in ps]
    assert all(x.exitcode == 0 for x in ps)
    assert len(reader) == 75 and len(reader.search("markets", k=100)) == 75  # the reader's cache noticed the new rows


def test_same_length_update_is_not_served_from_a_stale_cache():
    s = SqliteVectorStore()
    s.add("alpha beta gamma", id="x"); assert s.search("alpha", k=1)[0].entry.id == "x"
    s.add("delta omega sigma", id="x")  # same length, different content
    assert s.search("delta", k=1)[0].score > s.search("alpha", k=1)[0].score
