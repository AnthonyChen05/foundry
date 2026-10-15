package app.foundry.android

import app.foundry.android.core.Inbound
import app.foundry.android.core.IDEMPOTENT_METHODS
import app.foundry.android.core.PROTOCOL_VERSION
import app.foundry.android.core.chatOf
import app.foundry.android.core.parseFrame
import app.foundry.android.core.runOf
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Wire-frame contract vs docs/protocol.md §1.1 and the sdk-ts reference. */
class ProtocolTest {
    @Test
    fun `parses res frames with payload and error`() {
        val ok = parseFrame("""{"type":"res","id":"r1","ok":true,"payload":{"runId":"rr"}}""")
        assertTrue(ok is Inbound.Res)
        val res = ok as Inbound.Res
        assertTrue(res.ok)
        assertEquals("r1", res.id)
        assertFalse(res.isConnect)

        val fail = parseFrame("""{"type":"res","id":"connect","ok":false,"error":{"code":"unauthorized","message":"bad token"}}""")
        val err = fail as Inbound.Res
        assertTrue(err.isConnect)
        assertFalse(err.ok)
        assertEquals("unauthorized", err.error?.code)
    }

    @Test
    fun `parses event frames and tracks channel ids`() {
        val frame = parseFrame(
            """{"type":"event","event":"chat.delta","channel":"chat:c123","seq":7,"payload":{"runId":"r1","delta":"he" }}""",
        )
        assertTrue(frame is Inbound.Event)
        val ev = (frame as Inbound.Event).event
        assertEquals("chat.delta", ev.event)
        assertEquals("chat:c123", ev.channel)
        assertEquals(7, ev.seq)
        assertEquals("c123", chatOf(ev.channel))
        assertEquals("", chatOf("run:r9"))
        assertEquals("r9", runOf("run:r9"))
        assertEquals("", runOf("sys"))
    }

    @Test
    fun `executes-side req frames parse for the executor plane`() {
        val frame = parseFrame("""{"type":"req","id":"s1","method":"exec.exec","params":{}}""")
        assertTrue(frame is Inbound.Req)
        assertEquals("exec.exec", (frame as Inbound.Req).req.method)
    }

    @Test
    fun `malformed frames are dropped`() {
        assertNull(parseFrame("not json"))
        assertNull(parseFrame("""{"type":"weird"}"""))
        assertNull(parseFrame("""{"type":"res"}"""))
    }

    @Test
    fun `protocol version and idempotency set match protocol md`() {
        assertEquals(0, PROTOCOL_VERSION)
        assertTrue("chat.send" in IDEMPOTENT_METHODS)
        assertTrue("files.rm" in IDEMPOTENT_METHODS)
        assertTrue("chat.list" !in IDEMPOTENT_METHODS)
        assertTrue("term.input" in IDEMPOTENT_METHODS)
    }
}