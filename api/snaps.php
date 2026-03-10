<?php

declare(strict_types=1);

header('X-Robots-Tag: noindex, nofollow, noarchive, nosnippet, noimageindex');
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');

$snapsDir = dirname(__DIR__) . '/snaps';

if (!is_dir($snapsDir)) {
	mkdir($snapsDir, 0775, true);
}

if ($_SERVER['REQUEST_METHOD'] === 'GET') {
	header('Content-Type: application/json; charset=utf-8');
	echo json_encode(listSnaps($snapsDir));
	exit;
}

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
	header('Content-Type: application/json; charset=utf-8');

	if (!isset($_FILES['photo']) || !is_uploaded_file($_FILES['photo']['tmp_name'])) {
		http_response_code(400);
		echo json_encode(['error' => 'No photo uploaded']);
		exit;
	}

	$tmp = $_FILES['photo']['tmp_name'];
	$originalName = $_FILES['photo']['name'] ?? '';
	$ext = strtolower(pathinfo($originalName, PATHINFO_EXTENSION));
	$allowedExt = ['jpg', 'jpeg', 'png', 'webp', 'heic'];

	if (!in_array($ext, $allowedExt, true)) {
		$ext = 'jpg';
	}

	$filename = sprintf('%d-%s.%s', (int) round(microtime(true) * 1000), substr(bin2hex(random_bytes(4)), 0, 8), $ext);
	$target = $snapsDir . '/' . $filename;

	if (!move_uploaded_file($tmp, $target)) {
		http_response_code(500);
		echo json_encode(['error' => 'Upload failed']);
		exit;
	}

	clearstatcache(true, $target);
	$size = filesize($target);
	$createdAt = filemtime($target) ?: time();

	http_response_code(201);
	echo json_encode([
		'id' => $filename,
		'url' => './snaps/' . rawurlencode($filename),
		'createdAt' => ((float) $createdAt) * 1000,
		'size' => $size,
	]);
	exit;
}

http_response_code(405);
header('Allow: GET, POST');
echo 'Method Not Allowed';

function listSnaps(string $snapsDir): array
{
	$files = scandir($snapsDir);
	if ($files === false) {
		return [];
	}

	$result = [];
	foreach ($files as $file) {
		if ($file === '.' || $file === '..') {
			continue;
		}

		$full = $snapsDir . '/' . $file;
		if (!is_file($full)) {
			continue;
		}

		$result[] = [
			'id' => $file,
			'url' => './snaps/' . rawurlencode($file),
			'createdAt' => ((float) (filemtime($full) ?: time())) * 1000,
			'size' => filesize($full),
		];
	}

	usort(
		$result,
		static fn(array $a, array $b): int => ($a['createdAt'] <=> $b['createdAt'])
	);

	return $result;
}
