# 🚀 OpenAI-Compatible Translator for Translator++

[![Version](https://img.shields.io/badge/version-0.3.0-blue.svg)](https://dreamsavior.net)
[![Compatibility](https://img.shields.io/badge/translator++-v6.4.24+-green.svg)](https://dreamsavior.net)
[![License](https://img.shields.io/badge/license-MIT-orange.svg)](LICENSE)

Addon avanzado para **Translator++** optimizado para la localización de videojuegos (JRPGs, Visual Novels) utilizando backends compatibles con la API de OpenAI.

---

## ✨ Características Principales

- **Multi-Backend**: Soporte nativo para **LM Studio, OpenAI, DeepSeek, Gemini, Kimi** y endpoints personalizados.
- **Contexto Inteligente**:
  - **Sliding Window Memory**: Memoria de corto plazo para mantener la coherencia en diálogos.
  - **Project Harvesting**: Escaneo automático de metadatos del proyecto (actores, mapas, items, habilidades).
- **Protección de Estructura**:
  - **Placeholder Shield**: Protección avanzada para etiquetas de RPG Maker, Ren'Py y Wolf RPG.
  - **JSON Self-Healing**: Sistema tolerante a fallos para asegurar que el modelo siempre devuelva un formato válido.
- **Optimizado para Localización**:
  - Prompts específicos para preservar el tono, honoríficos y variables de motor.
  - Soporte para modelos de razonamiento (O1, DeepSeek-R1) y `extra_body` JSON.
  - Sistema de glosario flexible (=>, =, TAB).

---

## 🛠️ Configuración de Proveedores

| Proveedor | URL Base sugerida | Notas |
| :--- | :--- | :--- |
| **LM Studio** | `http://localhost:1234/v1` | Uso local, ideal para privacidad. |
| **OpenAI** | `https://api.openai.com/v1` | Estándar de la industria. |
| **Gemini** | `https://generativelanguage.googleapis.com/v1beta/openai/` | Soporta `reasoning_effort`. |
| **DeepSeek** | `https://api.deepseek.com` | Alta calidad a bajo costo. |
| **Kimi** | `https://api.moonshot.ai/v1` | Soporta modo `thinking` en K2.6. |

---

## 📖 Uso y Glosario

### Formato del Glosario
Acepta una entrada por línea, ideal para mantener consistencia en nombres y términos técnicos:
```text
Hero => Héroe
Demon Lord => Rey Demonio
\N[1] => \N[1]
HP	PV
```

### Presets de Rendimiento
- ⚡ **Speed**: Mayor concurrencia, menos contexto. Ideal para tradución masiva de UI.
- ⚖️ **Balanced**: Punto medio recomendado para uso general.
- 💎 **Quality**: Lotes pequeños y máximo contexto. Ideal para escenas narrativas.
- 🧠 **Reasoning**: Configuración optimizada para modelos tipo O1 o R1.

---

## 📦 Instalación

1. Descarga o clona este repositorio en tu carpeta de addons de Translator++.
2. Ejecuta `install-to-translatorpp.cmd` para una instalación automática con elevación de privilegios.
   - *Nota: El script creará un backup automático de la versión anterior antes de proceder.*

---

## 🤝 Contribuciones

Si deseas mejorar los prompts para un motor específico o añadir un proveedor:
1. Revisa la lógica en `OpenAICompatTranslator.js`.
2. Utiliza la carpeta `tester/` para validar tus cambios.
3. ¡Envía un Pull Request!

---

**Desarrollado por [Codex](https://dreamsavior.net)**  
*Optimizado para los amantes de las historias bien traducidas.*
