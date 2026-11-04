"""Tests for the text cleanup applied by the ``to_context()`` renderers."""

from __future__ import annotations

from keenable.models import Page, SearchResponse
from keenable.models import _clean_context_text as clean_context_text

BASE = "https://example.com/docs/guide?x=1"


def test_image_is_removed() -> None:
    text = 'Intro ![logo](https://cdn.example.com/a.png "Logo") text'
    assert clean_context_text(text, BASE) == "Intro text"


def test_image_inside_table_cell_is_removed() -> None:
    row = (
        "| $0.44 | $1.32 | "
        "![](https://cdn-avatars.huggingface.co/v1/production/uploads/x.png) "
        "| [fireworks-ai](/fireworks-ai) fastest |"
    )
    assert clean_context_text(row, "https://huggingface.co/models") == (
        "| $0.44 | $1.32 | "
        "| [fireworks-ai](https://huggingface.co/fireworks-ai) fastest |"
    )


def test_html_image_and_image_only_lines_are_dropped() -> None:
    text = 'a\n![](x.png)\n<IMG src="y.png" alt=y>\n| ![](z.png) |\nb'
    assert clean_context_text(text, BASE) == "a\nb"


def test_linked_image_leaves_nothing() -> None:
    assert clean_context_text("see [![badge](b.svg)](/ci) now", BASE) == "see now"


def test_relative_link_is_resolved_against_base() -> None:
    text = "Read [intro](intro) and [api](/api/v1)."
    assert clean_context_text(text, BASE) == (
        "Read [intro](https://example.com/docs/intro) and "
        "[api](https://example.com/api/v1)."
    )


def test_fragment_link_is_resolved_against_base() -> None:
    assert clean_context_text("[Install](#install)", BASE) == (
        "[Install](https://example.com/docs/guide?x=1#install)"
    )


def test_relative_link_without_usable_base_keeps_text() -> None:
    assert clean_context_text("[home](/home)", "") == "home"
    assert clean_context_text("[home](/home)", "not a url") == "home"


def test_absolute_link_is_unchanged() -> None:
    text = 'See [docs](https://other.org/z "Title") or [mail](mailto:a@b.c).'
    assert clean_context_text(text, BASE) == text


def test_text_without_markup_is_unchanged_byte_for_byte() -> None:
    text = "Plain  text\n\n|  a | b |\n|---|---|\n  indented\r\ntrailing  \n"
    assert clean_context_text(text, BASE) == text


def test_code_that_looks_like_a_link_is_unchanged() -> None:
    text = "Call fns[i]() or handlers[name](event)."
    assert clean_context_text(text, BASE) == text


def test_inline_code_is_left_alone_but_code_link_text_resolves() -> None:
    text = "See [`foo()`](/api/foo), not `![x](y)` ![a](b.png)"
    assert clean_context_text(text, BASE) == (
        "See [`foo()`](https://example.com/api/foo), not `![x](y)`"
    )


def test_fenced_code_block_is_left_alone() -> None:
    text = "```md\n![x](y.png)\n[a](b)\n```\n~~~\nf[i](x)\n~~~\nok ![c](d.png)"
    assert clean_context_text(text, BASE) == (
        "```md\n![x](y.png)\n[a](b)\n```\n~~~\nf[i](x)\n~~~\nok"
    )


def test_table_header_row_of_images_is_kept() -> None:
    text = "| ![a](x.png) | b |\n|---|---|\n| ![c](y.png) | |\n| 1 | 2 |"
    assert clean_context_text(text, BASE) == "| | b |\n|---|---|\n| 1 | 2 |"


def test_brackets_in_alt_and_parentheses_in_urls() -> None:
    text = 'A ![a [b] c](File_(1).png "t (x)") x [Foo](/wiki/Foo_(bar))'
    assert clean_context_text(text, BASE) == (
        "A x [Foo](https://example.com/wiki/Foo_(bar))"
    )


def test_hostile_input_is_cleaned_in_linear_time() -> None:
    import time

    started = time.monotonic()
    for text in ("![" * 50_000, "![a](" * 20_000, "<img " * 20_000):
        clean_context_text(text, BASE)
    # Quadratic patterns took tens of seconds on these.
    assert time.monotonic() - started < 2


def test_search_budget_counts_cleaned_length() -> None:
    noise = "![](https://cdn.example.com/" + "a" * 500 + ".png)"
    response = SearchResponse._from_json(
        {
            "results": [
                {
                    "title": "One",
                    "url": "https://one.example",
                    "snippet": f"First. {noise}",
                },
                {"title": "Two", "url": "https://two.example", "snippet": "Second."},
            ]
        },
        "q",
    )
    expected = "[1] One (https://one.example)\nFirst.\n\n[2] Two (https://two.example)\nSecond."
    # The raw snippet alone is over this budget; the cleaned one fits.
    assert response.to_context(max_chars=len(expected)) == expected
    assert [r.title for r in response.cited(max_chars=len(expected))] == ["One", "Two"]
    assert noise in response.results[0].snippet


def test_page_budget_counts_cleaned_length() -> None:
    noise = "![](https://cdn.example.com/" + "a" * 500 + ".png)"
    page = Page._from_json(
        {"title": "T", "content": f"{noise}\nReal text. See [more](/more)."},
        "https://example.com/p",
    )
    expected = "[1] T (https://example.com/p)\nReal text. See [more](https://example.com/more)."
    assert page.to_context(max_chars=len(expected)) == expected
    assert page.content.startswith(noise)
