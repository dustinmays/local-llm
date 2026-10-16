#!/bin/bash
# Each task: setup_<n> DIR ; prompt_<n> ; check_<n> DIR (exit 0 = pass)
TASKS="${ONLY:-t1 t2 t3 t4 t5}"

prompt_t1() { echo "Create a file hello.txt containing exactly the word hello followed by a newline."; }
setup_t1() { :; }
check_t1() { cmp -s "$1/hello.txt" <(printf 'hello\n'); }

prompt_t2() { echo "Run python3 -m unittest in this directory. Fix the bug in calc.py so the tests pass. Do not edit test_calc.py."; }
setup_t2() {
  printf 'def last_n(xs, n):\n    return xs[len(xs)-n+1:]\n' > "$1/calc.py"
  printf 'import unittest\nfrom calc import last_n\nclass T(unittest.TestCase):\n    def test_basic(self):\n        self.assertEqual(last_n([1,2,3,4], 2), [3,4])\n    def test_all(self):\n        self.assertEqual(last_n([1,2,3], 3), [1,2,3])\nif __name__ == "__main__":\n    unittest.main()\n' > "$1/test_calc.py"
  shasum "$1/test_calc.py" > "$1/.test.sha"
}
check_t2() { (cd "$1" && shasum -c .test.sha >/dev/null 2>&1 && python3 -m unittest >/dev/null 2>&1); }

prompt_t3() { echo "Rename the function get_user to fetch_user everywhere in this project (definition and all callers). Then run python3 -m unittest to confirm tests pass."; }
setup_t3() {
  printf 'def get_user(i):\n    return {"id": i}\n' > "$1/users.py"
  printf 'from users import get_user\ndef name_of(i):\n    return "user%%d" %% get_user(i)["id"]\n' > "$1/app.py"
  printf 'import unittest\nfrom app import name_of\nimport users\nclass T(unittest.TestCase):\n    def test(self):\n        self.assertEqual(name_of(3), "user3")\n        self.assertEqual(users.fetch_user(1)["id"], 1)\nif __name__ == "__main__":\n    unittest.main()\n' > "$1/test_app.py"
}
check_t3() { (cd "$1" && ! grep -rq get_user --include=*.py . && python3 -m unittest >/dev/null 2>&1); }

prompt_t4() { echo "Find the value of SECRET_CODE defined somewhere under the notes/ directory, and write just that value to answer.txt."; }
setup_t4() {
  mkdir -p "$1/notes/a" "$1/notes/b"
  for i in 1 2 3; do seq 1 60 | sed 's/^/filler line /' > "$1/notes/a/f$i.md"; done
  { seq 1 40 | sed 's/^/more filler /'; echo 'SECRET_CODE = zx-4417-pelican'; seq 1 40 | sed 's/^/tail filler /'; } > "$1/notes/b/x.md"
}
check_t4() { [ "$(tr -d '[:space:]' < "$1/answer.txt" 2>/dev/null)" = "zx-4417-pelican" ]; }

prompt_t5() { echo "Look at config.json, change the port from 8080 to 9090, then run ./check.sh and report its output."; }
setup_t5() {
  printf '{\n  "host": "localhost",\n  "port": 8080\n}\n' > "$1/config.json"
  printf '#!/bin/sh\ngrep -q "\\"port\\": 9090" config.json && echo OK || echo FAIL\n' > "$1/check.sh"; chmod +x "$1/check.sh"
}
check_t5() { grep -q '"port": 9090' "$1/config.json" && grep -q '"host": "localhost"' "$1/config.json"; }
