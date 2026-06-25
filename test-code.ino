#include <OneWire.h>
#include <DallasTemperature.h>

// ================= PINS =================
#define TURBIDITY_PIN       34
#define DS18B20_PIN         15
#define FLOW_PIN            27
#define MQ137_PIN           35
#define UV_RELAY_PIN         4
#define SOLENOID_RELAY_PIN  14
#define PUMP_RELAY_PIN      26
#define CIRC_PUMP_RELAY_PIN 25
#define RPWM                16
#define LPWM                17
#define R_EN                18
#define L_EN                19
#define STEP_PIN            12
#define DIR_PIN              2
#define ENABLE_PIN          13


// Add after stepDelay declaration:
String uvState      = "OFF";
String pumpState    = "OFF";
String peltierState = "OFF";
String valveState   = "CLOSED";
int stepDelay = 2000;

OneWire oneWire(DS18B20_PIN);
DallasTemperature sensors(&oneWire);

volatile int pulseCount = 0;
void IRAM_ATTR pulseCounter() { pulseCount++; }

void setup() {
  Serial.begin(115200);

  pinMode(TURBIDITY_PIN, INPUT);
  pinMode(MQ137_PIN,     INPUT);
  pinMode(FLOW_PIN,      INPUT_PULLUP);

  pinMode(UV_RELAY_PIN,        OUTPUT);
  pinMode(SOLENOID_RELAY_PIN,  OUTPUT);
  pinMode(PUMP_RELAY_PIN,      OUTPUT);
  pinMode(CIRC_PUMP_RELAY_PIN, OUTPUT);
  pinMode(RPWM,  OUTPUT); pinMode(LPWM, OUTPUT);
  pinMode(R_EN,  OUTPUT); pinMode(L_EN, OUTPUT);
  pinMode(STEP_PIN,   OUTPUT);
  pinMode(DIR_PIN,    OUTPUT);
  pinMode(ENABLE_PIN, OUTPUT);

  // All OFF at start
  digitalWrite(UV_RELAY_PIN,        HIGH);
  digitalWrite(SOLENOID_RELAY_PIN,  LOW);
  digitalWrite(PUMP_RELAY_PIN,      HIGH);
  digitalWrite(CIRC_PUMP_RELAY_PIN, HIGH);
  analogWrite(RPWM, 0); analogWrite(LPWM, 0);
  digitalWrite(R_EN, HIGH); digitalWrite(L_EN, HIGH);
  digitalWrite(ENABLE_PIN, HIGH);

  attachInterrupt(digitalPinToInterrupt(FLOW_PIN), pulseCounter, FALLING);
  sensors.begin();

  Serial.println("================================");
  Serial.println(" CRAYCHECK MANUAL TEST MODE     ");
  Serial.println("================================");
}

void loop() {
  unsigned long currentTime = millis();

  // Read all sensors every 1 second
  static unsigned long lastRead = 0;
  if (currentTime - lastRead >= 1000) {
    lastRead = currentTime;

    int turbidity = analogRead(TURBIDITY_PIN);
    int ammonia   = analogRead(MQ137_PIN);
    sensors.requestTemperatures();
    float temp    = sensors.getTempCByIndex(0);

    detachInterrupt(digitalPinToInterrupt(FLOW_PIN));
    float flow = ((1000.0 / 1000.0) * pulseCount) / 7.5;
    pulseCount = 0;
    attachInterrupt(digitalPinToInterrupt(FLOW_PIN), pulseCounter, FALLING);

   // Replace the existing Serial.print block with:
Serial.print("TURBIDITY:"); Serial.print(turbidity);
Serial.print(" | NH3:");    Serial.print(ammonia);
Serial.print(" | TEMP:");   Serial.print(temp, 1);
Serial.print(" | FLOW:");   Serial.print(flow, 2);
Serial.print("L/min");
Serial.print(" | UV:");     Serial.print(uvState);
Serial.print(" | PUMP:");   Serial.print(pumpState);
Serial.print(" | PELTIER:");Serial.print(peltierState);
Serial.print(" | VALVE:");  Serial.println(valveState);
  }

  // Commands
  if (Serial.available()) {
    String cmd = Serial.readStringUntil('\n');
    cmd.trim();

    if (cmd == "UV_ON")  { digitalWrite(UV_RELAY_PIN, LOW);  uvState = "ON";     Serial.println("OK:UV_ON");  }
if (cmd == "UV_OFF") { digitalWrite(UV_RELAY_PIN, HIGH); uvState = "OFF";    Serial.println("OK:UV_OFF"); }

if (cmd == "VALVE_ON")  { digitalWrite(SOLENOID_RELAY_PIN, HIGH); valveState = "OPEN";   Serial.println("OK:VALVE_ON");  }
if (cmd == "VALVE_OFF") { digitalWrite(SOLENOID_RELAY_PIN, LOW);  valveState = "CLOSED"; Serial.println("OK:VALVE_OFF"); }

if (cmd == "PUMP_ON")  { digitalWrite(PUMP_RELAY_PIN, LOW);  pumpState = "ON";  Serial.println("OK:PUMP_ON");  }
if (cmd == "PUMP_OFF") { digitalWrite(PUMP_RELAY_PIN, HIGH); pumpState = "OFF"; Serial.println("OK:PUMP_OFF"); }

if (cmd == "PELTIER_ON" || cmd == "COOL_MAX") {
  analogWrite(RPWM, 255); analogWrite(LPWM, 0);
  digitalWrite(CIRC_PUMP_RELAY_PIN, LOW);
  peltierState = "ON"; Serial.println("OK:PELTIER_ON");
}
if (cmd == "PELTIER_OFF" || cmd == "COOL_OFF") {
  analogWrite(RPWM, 0); analogWrite(LPWM, 0);
  digitalWrite(CIRC_PUMP_RELAY_PIN, HIGH);
  peltierState = "OFF"; Serial.println("OK:PELTIER_OFF");
}

    if (cmd == "MOVE_CW")  {
      digitalWrite(DIR_PIN, HIGH); digitalWrite(ENABLE_PIN, LOW);
      for (int i = 0; i < 800; i++) {
        digitalWrite(STEP_PIN, HIGH); delayMicroseconds(stepDelay);
        digitalWrite(STEP_PIN, LOW);  delayMicroseconds(stepDelay);
      }
      digitalWrite(ENABLE_PIN, HIGH);
      Serial.println("OK:MOVE_CW");
    }
    if (cmd == "MOVE_CCW") {
      digitalWrite(DIR_PIN, LOW); digitalWrite(ENABLE_PIN, LOW);
      for (int i = 0; i < 800; i++) {
        digitalWrite(STEP_PIN, HIGH); delayMicroseconds(stepDelay);
        digitalWrite(STEP_PIN, LOW);  delayMicroseconds(stepDelay);
      }
      digitalWrite(ENABLE_PIN, HIGH);
      Serial.println("OK:MOVE_CCW");
    }

    if (cmd == "PING") { Serial.println("PONG"); }
  }
}