package com.example.fictionaloctotribble

import org.junit.Assert.assertEquals
import org.junit.Test

class GreetingTest {
    @Test
    fun greetsByName() {
        assertEquals("Hello, Android!", greetingText("Android"))
    }

    @Test
    fun fallsBackToWorldForBlankName() {
        assertEquals("Hello, world!", greetingText("  "))
    }
}
