# A Makefile with each line shape check-rules must read.
OUT := dist
LINKS = docs:api
RULES ::= strict

.PHONY: check-links build

check-links:
	node scripts/links.mjs --format=a:b

build docs: $(OUT)
	echo build

%.o: %.c
	cc -c $<
