<?php
if ($_SERVER["REQUEST_METHOD"] === "POST") {
    
    $username = isset($_POST["username"]) ? trim($_POST["username"]) : "";
    $password = isset($_POST["password"]) ? $_POST["password"] : "";
    $recaptcha_token = isset($_POST["recaptcha_token"]) ? $_POST["recaptcha_token"] : "";

    if (empty($recaptcha_token)) {
        die("Authentication error: Missing security verification token.");
    }

    // Google Verification Settings with your active private Secret Key
    $secret_key = "6Lew6gMtAAAAANtjW7AU_AekxTHaRAvrv_5QR9WH"; 
    $verify_url = "https://www.google.com/recaptcha/api/siteverify";

    $data = [
        "secret" => $secret_key,
        "response" => $recaptcha_token,
        "remoteip" => $_SERVER["REMOTE_ADDR"]
    ];

    $options = [
        "http" => [
            "header"  => "Content-type: application/x-www-form-urlencoded\r\n",
            "method"  => "POST",
            "content" => http_build_query($data)
        ]
    ];

    $context  = stream_context_create($options);
    $response = file_get_contents($verify_url, false, $context);
    $response_keys = json_decode($response, true);

    // Evaluate the reCAPTCHA v3 bot probability score (0.0 to 1.0)
    if ($response_keys["success"] && $response_keys["score"] >= 0.5) {
        
        // SUCCESS: Clear to proceed!
        echo "<h1>Success!</h1>";
        echo "<p>Security check passed. Welcome back, " . htmlspecialchars($username) . "!</p>";
        
    } else {
        // FAIL: Automated bot action suspected
        http_response_code(403);
        echo "<h1>Access Denied</h1>";
        echo "<p>Automated or malicious login activity was detected by security filters.</p>";
    }
} else {
    http_response_code(405);
    echo "Method Not Allowed";
}
?>