// =====================================================================================
//  Secreto compartido entre la ESP32 y la página alarma.html
//
//  1. Copia este archivo como "secreto.h" en esta misma carpeta (secreto.h NO se sube a GitHub).
//  2. Cambia el texto por uno tuyo de al menos 16 caracteres.
//  3. Escribe el mismo texto en la página de la alarma la primera vez que te conectes.
//
//  Con él, la ESP32 firma cada orden (HMAC-SHA256): nadie puede armar o desarmar la alarma
//  con un mensaje inventado o repetido.
// =====================================================================================
#pragma once
#define SECRETO_ALARMA "cambia-este-secreto-ya"
