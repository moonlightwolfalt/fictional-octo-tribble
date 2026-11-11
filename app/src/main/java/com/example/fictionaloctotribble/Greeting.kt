package com.example.fictionaloctotribble

fun greetingText(name: String): String = "Hello, ${name.ifBlank { "world" }}!"
