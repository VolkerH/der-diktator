"""Deterministic search over persisted transcripts and custom chat names.

Queries use OR terms, exact/prefix matches, and a single spelling edit for terms
of at least four code points. These rules belong to the backend, not its clients.
"""

import unicodedata
from dataclasses import dataclass

from diktator.errors import ApiFailure

MAX_QUERY_LENGTH = 256
MAX_QUERY_TERMS = 16
MIN_FUZZY_LENGTH = 4


def tokens(text: str) -> tuple[str, ...]:
    """NFKC/casefold words made of letters/numbers and their attached Unicode marks.

    Punctuation, underscores and whitespace separate tokens. Keeping attached
    marks preserves scripts whose letters cannot be composed into single points.
    """
    normalized = unicodedata.normalize("NFKC", text).casefold()
    words: list[str] = []
    word: list[str] = []
    for character in normalized:
        category = unicodedata.category(character)[0]
        if category in {"L", "N"} or (category == "M" and word):
            word.append(character)
        elif word:
            words.append("".join(word))
            word = []
    if word:
        words.append("".join(word))
    return tuple(words)


def one_edit_apart(term: str, word: str) -> bool:
    """Allow one insertion, deletion, substitution or adjacent transposition.

    Length checks and one first-difference scan bound the work; no distance table
    or regular expression is needed. Prefix matching is handled separately.
    """
    if abs(len(term) - len(word)) > 1:
        return False
    position = next(
        (i for i, (left, right) in enumerate(zip(term, word, strict=False)) if left != right),
        min(len(term), len(word)),
    )
    if len(term) == len(word):
        return term[position + 1 :] == word[position + 1 :] or (
            position + 1 < len(term)
            and term[position] == word[position + 1]
            and term[position + 1] == word[position]
            and term[position + 2 :] == word[position + 2 :]
        )
    if len(term) > len(word):
        return term[position + 1 :] == word[position:]
    return term[position:] == word[position + 1 :]


@dataclass(frozen=True)
class SearchQuery:
    """Validated distinct terms; empty terms mean the ordinary unfiltered list."""

    terms: tuple[str, ...]

    def matches(self, text: str, title: str) -> bool:
        """Match any query term anywhere in the custom name or full transcript."""
        if not self.terms:
            return True
        # Repeated transcript words should not repeat fuzzy comparisons.
        words = set(tokens(title)) | set(tokens(text))
        return any(
            word.startswith(term) or (len(term) >= MIN_FUZZY_LENGTH and one_edit_apart(term, word))
            for term in self.terms
            for word in words
        )


def parse_query(value: str | None) -> SearchQuery:
    """Bound raw Unicode input before normalization; never silently truncate terms."""
    value = value or ""
    if len(value) > MAX_QUERY_LENGTH:
        raise ApiFailure("Search accepts up to 256 characters.", "invalid_search_query", 422)
    terms = tuple(dict.fromkeys(tokens(value)))
    if len(terms) > MAX_QUERY_TERMS:
        raise ApiFailure("Search accepts up to 16 different words.", "invalid_search_query", 422)
    return SearchQuery(terms)
