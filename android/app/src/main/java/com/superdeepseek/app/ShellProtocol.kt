package com.superdeepseek.app

/**
 * How the Studio terminal talks to its shell (a plain pipe, no PTY).
 *
 * Every command the user types is sent wrapped so that, when it finishes,
 * the shell prints an invisible marker with the exit code and the current
 * directory. The terminal strips the marker and learns from it that the
 * command is done (the Run button turns back from Stop), what it returned,
 * and where `cd` left the shell — so a stopped shell restarts in the same
 * folder.
 *
 * Lines typed while a command is still running are sent unwrapped: they are
 * the running program's input (answering "y" to a prompt).
 */
internal object ShellProtocol {
    /** ASCII record separator: never produced by ordinary program output. */
    const val MARK = '\u001E'
    private const val TAG = "SD:"
    /** A marker longer than this is not ours: show it as text. */
    private const val MAX_MARKER = 4096

    /**
     * [command] wrapped for the shell. The braces make the shell read the
     * whole unit before it runs anything, so the marker line cannot end up
     * as input of a program that reads stdin.
     */
    fun wrap(command: String): String =
            "{ $command\n} ; printf '\\036$TAG%s:%s\\036\\n' \"\$?\" \"\$PWD\"\n"

    /** The shell's own start-up noise (no TTY behind the pipe). */
    private val NOISE = Regex("(?m)^.*(can't access tty|job control turned off|no job control).*(\\n|$)")

    fun stripNoise(text: String): String = if (text.contains("tty") || text.contains("job control")) NOISE.replace(text, "") else text

    sealed class Event {
        data class Text(val text: String) : Event()
        data class Done(val exitCode: Int, val cwd: String) : Event()
    }

    /** Splits the shell's output into text and command-finished events; markers may arrive split across reads. */
    class Parser {
        private val carry = StringBuilder()
        /** The marker's own line break has not arrived yet. */
        private var dropNewline = false
        /** Whether the text shown so far ends a line (so "done" can start on a fresh one). */
        var atLineStart = true
            private set

        fun feed(chunk: String): List<Event> {
            val out = ArrayList<Event>()
            carry.append(chunk)
            val s = carry.toString()
            carry.setLength(0)
            var i = 0
            if (dropNewline && s.isNotEmpty()) {
                dropNewline = false
                if (s[0] == '\n') i = 1
            }
            val text = StringBuilder()
            while (i < s.length) {
                val open = s.indexOf(MARK, i)
                if (open < 0) { text.append(s, i, s.length); break }
                text.append(s, i, open)
                val close = s.indexOf(MARK, open + 1)
                if (close < 0) {
                    if (s.length - open > MAX_MARKER) { text.append(s, open, s.length) } else carry.append(s, open, s.length)
                    break
                }
                val body = s.substring(open + 1, close)
                val done = parseBody(body)
                if (done == null) {
                    // Not ours: keep the text, drop only the separator.
                    text.append(body)
                    i = close + 1
                    continue
                }
                flush(text, out)
                out.add(done)
                i = close + 1
                if (i < s.length) { if (s[i] == '\n') i++ } else dropNewline = true
            }
            flush(text, out)
            return out
        }

        private fun flush(text: StringBuilder, out: MutableList<Event>) {
            if (text.isEmpty()) return
            val t = text.toString()
            out.add(Event.Text(t))
            atLineStart = t.endsWith('\n')
            text.setLength(0)
        }

        private fun parseBody(body: String): Event.Done? {
            if (!body.startsWith(TAG)) return null
            val rest = body.substring(TAG.length)
            val colon = rest.indexOf(':')
            if (colon <= 0) return null
            val code = rest.substring(0, colon).toIntOrNull() ?: return null
            val cwd = rest.substring(colon + 1).ifEmpty { "/" }
            return Event.Done(code, cwd)
        }
    }
}
