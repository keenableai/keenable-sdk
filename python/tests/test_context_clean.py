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
        "$0.44 · $1.32 · [fireworks-ai](https://huggingface.co/fireworks-ai) fastest"
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
    text = "Plain  text\n\n  indented\r\ntrailing  \nCost | value, said nobody\n"
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


def test_indented_backticks_do_not_open_a_fence() -> None:
    # Four spaces make indented code in CommonMark, not a fence opener.
    text = "    ```\n![x](y.png)\nlater"
    assert clean_context_text(text, BASE) == "    ```\nlater"


def test_blockquoted_fenced_code_is_left_alone() -> None:
    text = "> ```md\n> ![x](y.png)\n> [a](/rel)\n> ```\nok ![c](d.png)"
    assert clean_context_text(text, BASE) == (
        "> ```md\n> ![x](y.png)\n> [a](/rel)\n> ```\nok"
    )


def test_code_span_with_shorter_inner_backticks_is_protected() -> None:
    text = "See ``a ` ![x](y.png)`` and more ![z](w.png)"
    assert clean_context_text(text, BASE) == "See ``a ` ![x](y.png)`` and more"


def test_adjacent_path_link_is_resolved() -> None:
    text = "See docs[API](/api) or call handlers[name](event)."
    assert clean_context_text(text, BASE) == (
        "See docs[API](https://example.com/api) or call handlers[name](event)."
    )


def test_table_rows_are_flattened_and_delimiter_rows_dropped() -> None:
    text = "| ![a](x.png) | b |\n|---|:--:|\n| ![c](y.png) | |\n|  1 |  2  |\nafter"
    assert clean_context_text(text, BASE) == "b\n1 · 2\nafter"


def test_huggingface_leaderboard_table_is_flattened() -> None:
    avatar = "https://cdn-avatars.huggingface.co/v1/production/uploads/{}.png"
    text = "\n".join(
        [
            "Open LLM leaderboard",
            "",
            "| Rank | Model | Provider | Score |",
            "|---:|:---|---|:-:|",
            f"| 1 | ![avatar]({avatar.format('a')}) [Llama-3](/meta/llama) "
            f"| ![avatar]({avatar.format('b')}) meta | 90.1 |",
            f"| ![]({avatar.format('c')}) | ![]({avatar.format('d')}) | | |",
            "| 2 | Qwen2 | ![](https://cdn-avatars.huggingface.co/e.png) qwen | 88 |",
        ]
    )
    assert clean_context_text(text, "https://huggingface.co/spaces/lb") == (
        "Open LLM leaderboard\n\n"
        "Rank · Model · Provider · Score\n"
        "1 · [Llama-3](https://huggingface.co/meta/llama) · meta · 90.1\n"
        "2 · Qwen2 · qwen · 88"
    )


def test_table_without_outer_pipes_is_flattened() -> None:
    text = "Name | Price\n--- | ---:\nA | $1\nB | $2\n\nprose"
    assert clean_context_text(text, BASE) == "Name · Price\nA · $1\nB · $2\n\nprose"


def test_escaped_pipe_in_a_cell_is_a_literal_pipe() -> None:
    text = "| op | meaning |\n|---|---|\n| a \\| b | either |"
    assert clean_context_text(text, BASE) == "op · meaning\na | b · either"


def test_pipe_inside_inline_code_is_not_a_cell_separator() -> None:
    text = "| flag | use |\n|---|---|\n| `a|b` | union |"
    assert clean_context_text(text, BASE) == "flag · use\n`a|b` · union"


def test_table_inside_a_fence_is_left_alone() -> None:
    text = "```\n| a | b |\n|---|---|\n| 1 | 2 |\n```\n| c | d |"
    assert clean_context_text(text, BASE) == (
        "```\n| a | b |\n|---|---|\n| 1 | 2 |\n```\nc · d"
    )


def test_prose_with_a_single_pipe_is_left_alone() -> None:
    text = "Home | About us\nUse a | b to pipe.\n`x | y`"
    assert clean_context_text(text, BASE) == text


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


def _response(*snippets: str) -> SearchResponse:
    return SearchResponse._from_json(
        {
            "results": [
                {"title": f"T{i}", "url": f"https://e.com/{i}", "snippet": snippet}
                for i, snippet in enumerate(snippets, start=1)
            ]
        },
        "q",
    )


def test_long_snippet_is_capped_at_a_word_boundary() -> None:
    words = " ".join(["word"] * 1_000)  # 4,999 characters
    context = _response(words).to_context()
    body = context.split("\n", 1)[1]
    assert body.endswith("word…")
    # The last space at or before 2,000 sits at 1,999; the cut drops it.
    assert len(body) == 1_999 + 1
    assert words in _response(words).results[0].snippet


def test_snippet_cap_cuts_at_a_space_exactly_at_the_limit() -> None:
    response = _response("aaaa bbbb cccc")
    assert response.to_context(max_snippet_chars=4).endswith("\naaaa…")
    assert response.to_context(max_snippet_chars=7).endswith("\naaaa…")
    assert response.to_context(max_snippet_chars=9).endswith("\naaaa bbbb…")


def test_snippet_cap_hard_cuts_text_without_spaces() -> None:
    response = _response("x" * 50)
    assert response.to_context(max_snippet_chars=10).endswith("\n" + "x" * 10 + "…")


def test_snippet_at_or_under_the_cap_is_untouched() -> None:
    response = _response("aaaa bbbb")
    assert response.to_context(max_snippet_chars=9).endswith("\naaaa bbbb")


def test_snippet_cap_none_disables_it() -> None:
    long = "y " * 3_000
    context = _response(long).to_context(max_snippet_chars=None, max_chars=100_000)
    assert context.endswith(long.strip())


def test_budget_counts_the_capped_snippet() -> None:
    long = " ".join(["word"] * 1_000)
    response = _response(long, long, long)
    # Uncapped, the first result alone is over budget; capped, all three fit.
    assert len(response.cited(max_chars=6_200)) == 3
    assert len(response.cited(max_chars=6_200, max_snippet_chars=None)) == 1
    context = response.to_context(max_chars=6_200)
    assert context.count("…") == 3


def test_first_result_is_kept_even_over_the_budget() -> None:
    response = _response("a " * 100, "b")
    cited = response.cited(max_chars=10, max_snippet_chars=None)
    assert [r.title for r in cited] == ["T1"]
